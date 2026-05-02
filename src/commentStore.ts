import * as vscode from "vscode";

type DiffSide = "before" | "after";

export interface DiffContext {
  baseRevision: string;
  headRevision: string;
}

export interface StoredComment {
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
  side: DiffSide;
  codeContext: string;
}

interface PersistedComment {
  uriString: string;
  startLine: number;
  endLine: number;
  body: string;
  codeContext: string;
}

interface PersistedState {
  comments: PersistedComment[];
  diffContext: DiffContext;
}

const STORAGE_KEY = "reviewComments";

export class CommentStore {
  private commentController: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];
  private threadCodeContext = new Map<vscode.CommentThread, string>();
  private reviewFileUris = new Set<string>();
  private _diffContext: DiffContext = {
    baseRevision: "",
    headRevision: "",
  };
  private state: vscode.Memento;

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(workspaceState: vscode.Memento) {
    this.state = workspaceState;
    this.commentController = vscode.comments.createCommentController(
      "localReview",
      "Local Review"
    );

    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (
        document: vscode.TextDocument
      ): vscode.Range[] => {
        if (
          document.uri.scheme === "local-review-git" ||
          this.reviewFileUris.has(document.uri.toString())
        ) {
          return [
            new vscode.Range(0, 0, document.lineCount - 1, 0),
          ];
        }
        return [];
      },
    };

    this.restore();
  }

  private persist(): void {
    const comments: PersistedComment[] = this.threads.map((thread) => {
      const range = thread.range;
      const body = thread.comments
        .map((c) => (typeof c.body === "string" ? c.body : c.body.value))
        .join("\n");
      return {
        uriString: thread.uri.toString(),
        startLine: range?.start.line ?? 0,
        endLine: range?.end.line ?? 0,
        body,
        codeContext: this.threadCodeContext.get(thread) ?? "",
      };
    });
    const persisted: PersistedState = {
      comments,
      diffContext: this._diffContext,
    };
    this.state.update(STORAGE_KEY, persisted);
  }

  private restore(): void {
    const persisted = this.state.get<PersistedState>(STORAGE_KEY);
    if (!persisted || persisted.comments.length === 0) {
      return;
    }
    this._diffContext = persisted.diffContext;
    for (const c of persisted.comments) {
      const uri = vscode.Uri.parse(c.uriString);
      const range = new vscode.Range(c.startLine, 0, c.endLine, 0);
      if (uri.scheme === "file") {
        this.reviewFileUris.add(uri.toString());
      }
      this.addThread(uri, range, c.body, c.codeContext);
    }
  }

  get diffContext(): DiffContext {
    return this._diffContext;
  }

  setDiffContext(ctx: DiffContext): void {
    this._diffContext = ctx;
  }

  hasComments(): boolean {
    return this.threads.length > 0;
  }

  addReviewFileUri(uri: vscode.Uri): void {
    this.reviewFileUris.add(uri.toString());
  }

  addThread(
    uri: vscode.Uri,
    range: vscode.Range,
    body: string,
    codeContext: string
  ): vscode.CommentThread {
    const thread = this.commentController.createCommentThread(
      uri,
      range,
      [
        {
          body: new vscode.MarkdownString(body),
          mode: vscode.CommentMode.Preview,
          author: { name: "Review" },
        },
      ]
    );
    thread.canReply = false;
    thread.collapsibleState =
      vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.push(thread);
    this.threadCodeContext.set(thread, codeContext);
    this.persist();
    this._onDidChange.fire();
    return thread;
  }

  getCommentForThread(
    thread: vscode.CommentThread
  ): StoredComment | undefined {
    const uri = thread.uri;
    let filePath: string;
    let revision = "";
    if (uri.scheme === "local-review-git") {
      filePath = uri.path.slice(1);
      revision = uri.authority;
    } else {
      filePath = vscode.workspace.asRelativePath(uri);
    }

    const side: DiffSide =
      revision === this._diffContext.baseRevision
        ? "before"
        : "after";

    const body = thread.comments
      .map((c) => {
        if (typeof c.body === "string") {
          return c.body;
        }
        return c.body.value;
      })
      .join("\n");

    const range = thread.range;
    if (!range) {
      return undefined;
    }

    return {
      filePath,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      body,
      side,
      codeContext: this.threadCodeContext.get(thread) ?? "",
    };
  }

  getAllComments(): StoredComment[] {
    const comments: StoredComment[] = [];
    for (const thread of this.threads) {
      const comment = this.getCommentForThread(thread);
      if (comment) {
        comments.push(comment);
      }
    }
    return comments.sort((a, b) => {
      const pathCmp = a.filePath.localeCompare(b.filePath);
      if (pathCmp !== 0) return pathCmp;
      return a.startLine - b.startLine;
    });
  }

  getThreads(): ReadonlyArray<{
    thread: vscode.CommentThread;
  }> {
    return this.threads.map((thread) => ({ thread }));
  }

  deleteThread(thread: vscode.CommentThread): void {
    const idx = this.threads.indexOf(thread);
    if (idx !== -1) {
      this.threadCodeContext.delete(thread);
      thread.dispose();
      this.threads.splice(idx, 1);
      this.persist();
      this._onDidChange.fire();
    }
  }

  deleteThreadByComment(comment: vscode.Comment): void {
    const thread = this.threads.find((t) =>
      t.comments.includes(comment)
    );
    if (thread) {
      this.deleteThread(thread);
    }
  }

  clearAll(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.threadCodeContext.clear();
    this.persist();
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.threadCodeContext.clear();
    this._onDidChange.dispose();
    this.commentController.dispose();
  }
}

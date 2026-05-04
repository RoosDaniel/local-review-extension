import * as vscode from "vscode";

type DiffSide = "before" | "after";

export type CommentType = "issue" | "suggestion" | "question" | "nitpick";

export const COMMENT_TYPES: readonly CommentType[] = [
  "question",
  "suggestion",
  "issue",
  "nitpick",
];

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
  type: CommentType;
}

interface PersistedComment {
  uriString: string;
  startLine: number;
  endLine: number;
  body: string;
  codeContext: string;
  type: CommentType;
}

interface PersistedState {
  comments: PersistedComment[];
  diffContext: DiffContext;
}

const STORAGE_KEY = "reviewComments";

export function commentBody(comment: vscode.Comment): string {
  return typeof comment.body === "string"
    ? comment.body
    : comment.body.value;
}

export class CommentStore {
  private commentController: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];
  private threadCodeContext = new Map<vscode.CommentThread, string>();
  private threadCommentType = new Map<vscode.CommentThread, CommentType>();
  private editSnapshots = new Map<vscode.CommentThread, string>();
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
      const body = thread.comments.map(commentBody).join("\n");
      return {
        uriString: thread.uri.toString(),
        startLine: range?.start.line ?? 0,
        endLine: range?.end.line ?? 0,
        body,
        codeContext: this.threadCodeContext.get(thread) ?? "",
        type: this.threadCommentType.get(thread) ?? "issue",
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
      this.addThread(uri, range, c.body, c.codeContext, c.type ?? "issue");
    }
  }

  private rebuildReviewFileUris(): void {
    this.reviewFileUris.clear();
    for (const thread of this.threads) {
      if (thread.uri.scheme === "file") {
        this.reviewFileUris.add(thread.uri.toString());
      }
    }
  }

  private disposeThreads(): void {
    for (const thread of this.threads) {
      thread.dispose();
    }
    this.threads = [];
    this.threadCodeContext.clear();
    this.threadCommentType.clear();
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
    codeContext: string,
    type: CommentType
  ): vscode.CommentThread {
    const thread = this.commentController.createCommentThread(
      uri,
      range,
      [
        {
          body: new vscode.MarkdownString(body),
          mode: vscode.CommentMode.Preview,
          author: { name: `Review [${type}]` },
        },
      ]
    );
    thread.canReply = false;
    thread.collapsibleState =
      vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.push(thread);
    this.threadCodeContext.set(thread, codeContext);
    this.threadCommentType.set(thread, type);
    this.persist();
    this._onDidChange.fire();
    return thread;
  }

  getTypeForThread(thread: vscode.CommentThread): CommentType {
    return this.threadCommentType.get(thread) ?? "issue";
  }

  buildStoredComment(
    uri: vscode.Uri,
    range: vscode.Range,
    body: string,
    codeContext: string,
    type: CommentType
  ): StoredComment {
    let filePath: string;
    let revision = "";
    if (uri.scheme === "local-review-git") {
      filePath = uri.path.slice(1);
      revision = uri.authority;
    } else {
      filePath = vscode.workspace.asRelativePath(uri);
    }

    const side: DiffSide =
      revision === this._diffContext.baseRevision ? "before" : "after";

    return {
      filePath,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      body,
      side,
      codeContext,
      type,
    };
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

    const body = thread.comments.map(commentBody).join("\n");

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
      type: this.threadCommentType.get(thread) ?? "issue",
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
      this.threadCommentType.delete(thread);
      thread.dispose();
      this.threads.splice(idx, 1);
      this.rebuildReviewFileUris();
      this.persist();
      this._onDidChange.fire();
    }
  }

  findThreadByComment(comment: vscode.Comment): vscode.CommentThread | undefined {
    return this.threads.find((t) => t.comments.includes(comment));
  }

  deleteThreadByComment(comment: vscode.Comment): void {
    const thread = this.findThreadByComment(comment);
    if (thread) {
      this.deleteThread(thread);
    }
  }

  editComment(thread: vscode.CommentThread): void {
    const comment = thread.comments[0];
    if (!comment) return;
    this.editSnapshots.set(thread, commentBody(comment));
    thread.comments = [
      {
        body: commentBody(comment),
        mode: vscode.CommentMode.Editing,
        author: comment.author,
      },
    ];
  }

  saveComment(thread: vscode.CommentThread, newBody: string, newType?: CommentType): void {
    this.editSnapshots.delete(thread);
    const type = newType ?? this.getTypeForThread(thread);
    if (newType) {
      this.threadCommentType.set(thread, newType);
    }
    thread.comments = [
      {
        body: new vscode.MarkdownString(newBody),
        mode: vscode.CommentMode.Preview,
        author: { name: `Review [${type}]` },
      },
    ];
    this.persist();
    this._onDidChange.fire();
  }

  cancelEdit(thread: vscode.CommentThread): void {
    const original = this.editSnapshots.get(thread);
    if (original === undefined) return;
    this.editSnapshots.delete(thread);
    const type = this.getTypeForThread(thread);
    thread.comments = [
      {
        body: new vscode.MarkdownString(original),
        mode: vscode.CommentMode.Preview,
        author: { name: `Review [${type}]` },
      },
    ];
  }

  clearAll(): void {
    this.disposeThreads();
    this.reviewFileUris.clear();
    this.persist();
    this._onDidChange.fire();
  }

  dispose(): void {
    this.disposeThreads();
    this._onDidChange.dispose();
    this.commentController.dispose();
  }
}

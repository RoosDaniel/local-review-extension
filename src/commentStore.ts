import * as vscode from "vscode";

type DiffSide = "before" | "after";

export interface StoredComment {
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
  side: DiffSide;
  baseRevision: string;
  headRevision: string;
  codeContext: string;
}

interface ThreadMeta {
  diffContext: { baseRevision: string; headRevision: string };
  codeContext: string;
}

export class CommentStore {
  private commentController: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];
  private threadMeta = new Map<vscode.CommentThread, ThreadMeta>();

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this.commentController = vscode.comments.createCommentController(
      "localReview",
      "Local Review"
    );

    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (
        document: vscode.TextDocument
      ): vscode.Range[] => {
        if (document.uri.scheme === "local-review-git") {
          return [
            new vscode.Range(0, 0, document.lineCount - 1, 0),
          ];
        }
        return [];
      },
    };
  }

  addThread(
    uri: vscode.Uri,
    range: vscode.Range,
    body: string,
    diffContext: { baseRevision: string; headRevision: string },
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
    this.threadMeta.set(thread, { diffContext, codeContext });
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

    const meta = this.threadMeta.get(thread);
    const side: DiffSide =
      revision === meta?.diffContext.baseRevision
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
      baseRevision: meta?.diffContext.baseRevision ?? "",
      headRevision: meta?.diffContext.headRevision ?? "",
      codeContext: meta?.codeContext ?? "",
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
    meta: ThreadMeta | undefined;
  }> {
    return this.threads.map((thread) => ({
      thread,
      meta: this.threadMeta.get(thread),
    }));
  }

  deleteThread(thread: vscode.CommentThread): void {
    const idx = this.threads.indexOf(thread);
    if (idx !== -1) {
      this.threadMeta.delete(thread);
      thread.dispose();
      this.threads.splice(idx, 1);
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
    this.threadMeta.clear();
    this._onDidChange.fire();
  }

  dispose(): void {
    this.clearAll();
    this._onDidChange.dispose();
    this.commentController.dispose();
  }
}

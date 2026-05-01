import * as vscode from "vscode";
import { CommentStore } from "./commentStore";

interface CommentItem {
  thread: vscode.CommentThread;
  body: string;
  filePath: string;
  lineRange: string;
}

const MAX_LABEL_LENGTH = 60;

export class CommentsTreeProvider
  implements vscode.TreeDataProvider<CommentItem>
{
  private items: CommentItem[] = [];

  private _onDidChangeTreeData =
    new vscode.EventEmitter<CommentItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: CommentStore) {
    store.onDidChange(() => this.refresh());
  }

  private refresh(): void {
    this.items = this.store.getThreads().map(({ thread }) => {
      const body = thread.comments
        .map((c) =>
          typeof c.body === "string" ? c.body : c.body.value
        )
        .join(" ");

      const uri = thread.uri;
      const filePath =
        uri.scheme === "local-review-git"
          ? uri.path.slice(1)
          : uri.fsPath;

      const startLine = (thread.range?.start.line ?? 0) + 1;
      const endLine = (thread.range?.end.line ?? 0) + 1;
      const lineRange =
        startLine === endLine
          ? `${startLine}`
          : `${startLine}-${endLine}`;

      return { thread, body, filePath, lineRange };
    });

    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: CommentItem): vscode.TreeItem {
    const truncated =
      element.body.length > MAX_LABEL_LENGTH
        ? `${element.body.slice(0, MAX_LABEL_LENGTH)}...`
        : element.body;

    const item = new vscode.TreeItem(
      truncated,
      vscode.TreeItemCollapsibleState.None
    );

    const fileName = element.filePath.split("/").pop() ?? element.filePath;
    item.description = `${fileName}:${element.lineRange}`;
    item.tooltip = `${element.filePath}:${element.lineRange}\n\n${element.body}`;

    item.command = {
      command: "localReview.goToComment",
      title: "Go to Comment",
      arguments: [element],
    };

    return item;
  }

  getChildren(): CommentItem[] {
    return this.items;
  }
}

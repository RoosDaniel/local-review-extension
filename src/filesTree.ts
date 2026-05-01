import * as vscode from "vscode";
import { type ChangedFile, getChangedFiles } from "./git";


const STATUS_LABELS: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
};

export class FilesTreeProvider
  implements vscode.TreeDataProvider<ChangedFile>
{
  private files: ChangedFile[] = [];
  private cwd: string;
  private mergeBase = "";
  private headCommit = "";

  private _onDidChangeTreeData =
    new vscode.EventEmitter<ChangedFile | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async updateFiles(
    selectedHashes: string[],
    mergeBase: string
  ): Promise<void> {
    this.mergeBase = mergeBase;
    // Use the most recent selected commit as HEAD for diffs
    this.headCommit =
      selectedHashes.length > 0 ? selectedHashes[0] : "";
    this.files = await getChangedFiles(
      this.cwd,
      selectedHashes,
      mergeBase
    );
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ChangedFile): vscode.TreeItem {
    const label = element.path.split("/").pop() ?? element.path;
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None
    );
    const dir = element.path.includes("/")
      ? element.path.slice(0, element.path.length - label.length - 1)
      : undefined;
    const statusLabel = STATUS_LABELS[element.status] ?? element.status;

    item.description = `${dir ?? ""} [${statusLabel}]`.trim();
    item.tooltip = `${element.path} (${statusLabel})`;
    item.resourceUri = vscode.Uri.file(`${this.cwd}/${element.path}`);
    item.command = {
      command: "localReview.openDiff",
      title: "Open Diff",
      arguments: [element.path, this.mergeBase, this.headCommit],
    };

    return item;
  }

  getChildren(): ChangedFile[] {
    return this.files;
  }
}

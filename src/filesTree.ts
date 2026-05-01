import * as vscode from "vscode";
import {
  type ChangedFile,
  getChangedFiles,
  getFileCommitMap,
} from "./git";
import { ApprovalStore } from "./approvalStore";

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
  private selectedHashes: string[] = [];
  // filePath -> set of commit hashes that modified it
  private fileCommitMap = new Map<string, Set<string>>();

  private _onDidChangeTreeData =
    new vscode.EventEmitter<ChangedFile | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    cwd: string,
    private approvalStore: ApprovalStore
  ) {
    this.cwd = cwd;
    approvalStore.onDidChange(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  async updateFiles(
    selectedHashes: string[],
    mergeBase: string
  ): Promise<void> {
    this.mergeBase = mergeBase;
    this.selectedHashes = selectedHashes;
    this.headCommit =
      selectedHashes.length > 0 ? selectedHashes[0] : "";
    this.files = await getChangedFiles(
      this.cwd,
      selectedHashes,
      mergeBase
    );
    this.fileCommitMap = await getFileCommitMap(
      this.cwd,
      selectedHashes
    );
    this._onDidChangeTreeData.fire(undefined);
  }

  getCommitsForFile(filePath: string): Set<string> {
    return this.fileCommitMap.get(filePath) ?? new Set();
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
    const statusLabel =
      STATUS_LABELS[element.status] ?? element.status;

    item.description = `${dir ?? ""} [${statusLabel}]`.trim();
    item.tooltip = `${element.path} (${statusLabel})`;
    item.resourceUri = vscode.Uri.file(
      `${this.cwd}/${element.path}`
    );
    item.command = {
      command: "localReview.openDiff",
      title: "Open Diff",
      arguments: [element.path, this.mergeBase, this.headCommit],
    };

    const commits = this.getCommitsForFile(element.path);
    if (!commits.has("uncommitted") && commits.size > 0) {
      const approved = this.approvalStore.isApproved(
        element.path,
        commits
      );
      item.checkboxState = approved
        ? { state: vscode.TreeItemCheckboxState.Checked, tooltip: "Reviewed" }
        : { state: vscode.TreeItemCheckboxState.Unchecked, tooltip: "Unreviewed" };
    }

    return item;
  }

  refreshTree(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(): ChangedFile[] {
    return this.files;
  }
}

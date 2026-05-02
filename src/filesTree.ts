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

type GroupLabel = "Unreviewed" | "Reviewed";

interface GroupItem {
  kind: "group";
  label: GroupLabel;
}

interface FileItem {
  kind: "file";
  file: ChangedFile;
}

type TreeNode = GroupItem | FileItem;

export class FilesTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private files: ChangedFile[] = [];
  private cwd: string;
  private mergeBase = "";
  private headCommit = "";
  private fileCommitMap = new Map<string, Set<string>>();

  private _onDidChangeTreeData =
    new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private approvalListener: vscode.Disposable;

  constructor(
    cwd: string,
    private approvalStore: ApprovalStore
  ) {
    this.cwd = cwd;
    this.approvalListener = approvalStore.onDidChange(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  async updateFiles(
    selectedHashes: string[],
    mergeBase: string
  ): Promise<void> {
    this.mergeBase = mergeBase;
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

  private isFileApproved(file: ChangedFile): boolean {
    const commits = this.getCommitsForFile(file.path);
    if (commits.has("uncommitted") || commits.size === 0) {
      return false;
    }
    return this.approvalStore.isApproved(file.path, commits);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      const count = this.getGroupFiles(element.label).length;
      item.description = `${count}`;
      return item;
    }

    const { file } = element;
    const label = file.path.split("/").pop() ?? file.path;
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.None
    );
    const dir = file.path.includes("/")
      ? file.path.slice(
          0,
          file.path.length - label.length - 1
        )
      : undefined;
    const statusLabel =
      STATUS_LABELS[file.status] ?? file.status;

    item.description = `${dir ?? ""} [${statusLabel}]`.trim();
    item.tooltip = `${file.path} (${statusLabel})`;
    item.resourceUri = vscode.Uri.joinPath(
      vscode.Uri.file(this.cwd),
      file.path
    );
    item.command = {
      command: "localReview.openDiff",
      title: "Open Diff",
      arguments: [file.path, this.mergeBase, this.headCommit],
    };

    const commits = this.getCommitsForFile(file.path);
    if (!commits.has("uncommitted") && commits.size > 0) {
      const approved = this.approvalStore.isApproved(
        file.path,
        commits
      );
      item.checkboxState = approved
        ? {
            state: vscode.TreeItemCheckboxState.Checked,
            tooltip: "Mark as unreviewed",
          }
        : {
            state: vscode.TreeItemCheckboxState.Unchecked,
            tooltip: "Mark as reviewed",
          };
    }

    return item;
  }

  private getGroupFiles(label: GroupLabel): ChangedFile[] {
    if (label === "Reviewed") {
      return this.files.filter((f) => this.isFileApproved(f));
    }
    return this.files.filter((f) => !this.isFileApproved(f));
  }

  refreshTree(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getParent(element: TreeNode): TreeNode | undefined {
    if (element.kind === "file") {
      const label: GroupLabel = this.isFileApproved(element.file)
        ? "Reviewed"
        : "Unreviewed";
      return { kind: "group", label };
    }
    return undefined;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const unreviewed = this.getGroupFiles("Unreviewed");
      const reviewed = this.getGroupFiles("Reviewed");
      const groups: TreeNode[] = [];
      if (unreviewed.length > 0) {
        groups.push({ kind: "group", label: "Unreviewed" });
      }
      if (reviewed.length > 0) {
        groups.push({ kind: "group", label: "Reviewed" });
      }
      return groups;
    }
    if (element.kind === "group") {
      return this.getGroupFiles(element.label).map((file) => ({
        kind: "file",
        file,
      }));
    }
    return [];
  }

  dispose(): void {
    this.approvalListener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

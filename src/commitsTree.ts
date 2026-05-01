import * as vscode from "vscode";
import { getCommits, getMainBranch, getMergeBase } from "./git";

interface CommitItem {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  checked: boolean;
}

export class CommitsTreeProvider
  implements vscode.TreeDataProvider<CommitItem>
{
  private commits: CommitItem[] = [];
  private cwd: string;
  private mergeBase = "";

  private _onDidChangeTreeData =
    new vscode.EventEmitter<CommitItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _onSelectionChanged = new vscode.EventEmitter<string[]>();
  readonly onSelectionChanged = this._onSelectionChanged.event;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  getSelectedHashes(): string[] {
    return this.commits
      .filter((c) => c.checked)
      .map((c) => c.hash);
  }

  /** The effective base for the selected range: parent of the oldest selected commit, or merge base. */
  getEffectiveBase(): string {
    const lastChecked = this.commits.findLastIndex((c) => c.checked);
    if (lastChecked === -1) {
      return this.mergeBase;
    }
    // If there's a commit after the oldest selected, that's the parent
    if (lastChecked + 1 < this.commits.length) {
      return this.commits[lastChecked + 1].hash;
    }
    return this.mergeBase;
  }

  async refresh(): Promise<void> {
    const mainBranch = await getMainBranch(this.cwd);
    this.mergeBase = await getMergeBase(this.cwd, mainBranch);

    const commits = await getCommits(this.cwd, mainBranch);
    this.commits = commits.map((c) => ({ ...c, checked: true }));
    this._onDidChangeTreeData.fire(undefined);
    this._onSelectionChanged.fire(this.getSelectedHashes());
  }

  getTreeItem(element: CommitItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.subject,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = `${element.shortHash} - ${element.author} (${element.date})`;
    item.tooltip = `${element.hash}\n${element.subject}\n${element.author} - ${element.date}`;
    item.checkboxState = element.checked
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.contextValue = "commit";
    return item;
  }

  getChildren(): CommitItem[] {
    return this.commits;
  }

  setAll(checked: boolean): void {
    for (const commit of this.commits) {
      commit.checked = checked;
    }
    this._onDidChangeTreeData.fire(undefined);
    this._onSelectionChanged.fire(this.getSelectedHashes());
  }

  handleCheckboxChange(
    items: ReadonlyArray<[CommitItem, vscode.TreeItemCheckboxState]>
  ): void {
    // Apply the user's toggle first
    for (const [commitItem, state] of items) {
      commitItem.checked =
        state === vscode.TreeItemCheckboxState.Checked;
    }

    // Enforce contiguity: find first and last checked, fill the gap
    const firstChecked = this.commits.findIndex((c) => c.checked);
    const lastChecked = this.commits.findLastIndex((c) => c.checked);

    if (firstChecked !== -1 && lastChecked !== -1) {
      for (let i = firstChecked; i <= lastChecked; i++) {
        this.commits[i].checked = true;
      }
    }

    // Refresh tree to reflect any auto-corrections
    this._onDidChangeTreeData.fire(undefined);
    this._onSelectionChanged.fire(this.getSelectedHashes());
  }
}

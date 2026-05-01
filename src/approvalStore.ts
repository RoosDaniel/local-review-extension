import * as vscode from "vscode";

const STORAGE_KEY = "approvedFiles";

/** Tracks per-commit-per-file approval as "commitHash:filePath" entries. */
export class ApprovalStore {
  private approved: Set<string>;
  private state: vscode.Memento;

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(workspaceState: vscode.Memento) {
    this.state = workspaceState;
    const stored = workspaceState.get<string[]>(STORAGE_KEY, []);
    this.approved = new Set(stored);
  }

  private key(commitHash: string, filePath: string): string {
    return `${commitHash}:${filePath}`;
  }

  private persist(): void {
    this.state.update(STORAGE_KEY, Array.from(this.approved));
  }

  /** Approve a file for all given commits. */
  approve(filePath: string, commitHashes: Iterable<string>): void {
    for (const hash of commitHashes) {
      this.approved.add(this.key(hash, filePath));
    }
    this.persist();
    this._onDidChange.fire();
  }

  /** Unapprove a file for all given commits. */
  unapprove(
    filePath: string,
    commitHashes: Iterable<string>
  ): void {
    for (const hash of commitHashes) {
      this.approved.delete(this.key(hash, filePath));
    }
    this.persist();
    this._onDidChange.fire();
  }

  /**
   * Check if a file is fully approved for a set of commits.
   * Returns true only if every commit that touches this file is approved.
   */
  isApproved(
    filePath: string,
    commitsThatTouchFile: Iterable<string>
  ): boolean {
    for (const hash of commitsThatTouchFile) {
      if (!this.approved.has(this.key(hash, filePath))) {
        return false;
      }
    }
    return true;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

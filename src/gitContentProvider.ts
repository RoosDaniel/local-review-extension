import * as vscode from "vscode";
import { getFileAtRevision } from "./git";

/**
 * Provides file content at a specific git revision.
 * URI format: local-review-git://<revision>/<file-path>
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const revision = uri.authority;
    const filePath = uri.path.slice(1); // remove leading /
    return getFileAtRevision(this.cwd, revision, filePath);
  }
}

export function makeGitUri(revision: string, filePath: string): vscode.Uri {
  return vscode.Uri.parse(
    `local-review-git://${revision}/${filePath}`
  );
}

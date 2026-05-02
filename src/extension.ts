import * as vscode from "vscode";
import {
  fileHasUncommittedChanges,
  getHeadHash,
  getRepoId,
  getRepoRoot,
  log,
} from "./git";
import { UNCOMMITTED } from "./commitsTree";
import { GitContentProvider, makeGitUri } from "./gitContentProvider";
import { CommitsTreeProvider } from "./commitsTree";
import { FilesTreeProvider } from "./filesTree";
import { CommentsTreeProvider } from "./commentsTree";
import { CommentStore, commentBody } from "./commentStore";
import { ApprovalStore } from "./approvalStore";
import {
  formatSingleComment,
  formatReviewForClipboard,
} from "./export";

const SELECTION_LOCKED_MSG =
  "Clear all comments before changing commit selection.";

/** Wraps a Memento to prefix all keys, scoping storage to a specific repo. */
function scopedMemento(
  memento: vscode.Memento,
  prefix: string
): vscode.Memento {
  return {
    keys: () =>
      memento
        .keys()
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length)),
    get<T>(key: string, defaultValue?: T): T {
      return memento.get(`${prefix}${key}`, defaultValue) as T;
    },
    update(key: string, value: unknown): Thenable<void> {
      return memento.update(`${prefix}${key}`, value);
    },
  };
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage(
      "Local Review: No workspace folder open"
    );
    return;
  }

  let cwd: string;
  try {
    cwd = await getRepoRoot(workspaceFolder.uri.fsPath);
  } catch {
    vscode.window.showWarningMessage(
      "Local Review: Not a git repository"
    );
    return;
  }

  context.subscriptions.push(log);

  const repoId = await getRepoId(cwd);
  const state = scopedMemento(
    context.globalState,
    `repo:${repoId}:`
  );

  // Git content provider for viewing files at specific revisions
  const gitContentProvider = new GitContentProvider(cwd);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "local-review-git",
      gitContentProvider
    )
  );

  // Comment store
  const commentStore = new CommentStore(context.workspaceState);
  context.subscriptions.push({
    dispose: () => commentStore.dispose(),
  });

  // Approval store (shared across worktrees via globalState)
  const approvalStore = new ApprovalStore(state);
  context.subscriptions.push({
    dispose: () => approvalStore.dispose(),
  });

  // Tree providers
  const commitsTree = new CommitsTreeProvider(cwd, context.workspaceState);
  context.subscriptions.push({
    dispose: () => commitsTree.dispose(),
  });

  const filesTree = new FilesTreeProvider(cwd, approvalStore);
  context.subscriptions.push({
    dispose: () => filesTree.dispose(),
  });

  const commitsTreeView = vscode.window.createTreeView(
    "localReview.commits",
    {
      treeDataProvider: commitsTree,
      manageCheckboxStateManually: true,
    }
  );
  context.subscriptions.push(commitsTreeView);

  const filesTreeView = vscode.window.createTreeView(
    "localReview.files",
    {
      treeDataProvider: filesTree,
      manageCheckboxStateManually: true,
    }
  );
  context.subscriptions.push(filesTreeView);

  context.subscriptions.push(
    filesTreeView.onDidChangeCheckboxState((e) => {
      for (const [node, state] of e.items) {
        if (node.kind !== "file") continue;
        const commits = filesTree.getCommitsForFile(node.file.path);
        if (state === vscode.TreeItemCheckboxState.Checked) {
          approvalStore.approve(node.file.path, commits);
        } else {
          approvalStore.unapprove(node.file.path, commits);
        }
      }
    })
  );

  // Comments panel
  const commentsTree = new CommentsTreeProvider(commentStore);
  context.subscriptions.push({
    dispose: () => commentsTree.dispose(),
  });
  context.subscriptions.push(
    vscode.window.createTreeView("localReview.comments", {
      treeDataProvider: commentsTree,
    })
  );

  function requireNoComments(): boolean {
    if (commentStore.hasComments()) {
      vscode.window.showWarningMessage(SELECTION_LOCKED_MSG);
      return false;
    }
    return true;
  }

  // Wire up checkbox changes -> file list updates (blocked when comments exist)
  context.subscriptions.push(
    commitsTreeView.onDidChangeCheckboxState((e) => {
      if (!requireNoComments()) {
        commitsTree.refreshTree();
        return;
      }
      commitsTree.handleCheckboxChange(e.items);
    })
  );

  // Toggle commit via click (same lock logic as checkbox)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.toggleCommit",
      (item: { hash: string }) => {
        if (!requireNoComments()) return;
        commitsTree.toggleCommit(item.hash);
      }
    )
  );

  let currentDiffFilePath = "";
  let selectionGeneration = 0;

  context.subscriptions.push(
    commitsTree.onSelectionChanged(async (selectedHashes) => {
      const generation = ++selectionGeneration;
      const effectiveBase = commitsTree.getEffectiveBase();
      commentStore.setDiffContext({
        baseRevision: effectiveBase,
        headRevision: selectedHashes.length > 0 ? selectedHashes[0] : "",
      });
      await filesTree.updateFiles(selectedHashes, effectiveBase);

      // Bail if a newer selection arrived while we were awaiting
      if (generation !== selectionGeneration) return;

      // Re-open the current diff with the new base/head
      if (currentDiffFilePath) {
        await vscode.commands.executeCommand(
          "localReview.openDiff",
          currentDiffFilePath,
          effectiveBase,
          commentStore.diffContext.headRevision
        );
      }
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("localReview.selectAll", () => {
      if (!requireNoComments()) return;
      commitsTree.setAll(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localReview.deselectAll", () => {
      if (!requireNoComments()) return;
      commitsTree.setAll(false);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.refresh",
      async () => {
        await commitsTree.refresh();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.openDiff",
      async (
        filePath: string,
        mergeBase: string,
        headCommit: string
      ) => {
        currentDiffFilePath = filePath;
        commentStore.setDiffContext({
          baseRevision: mergeBase,
          headRevision: headCommit,
        });
        const leftUri = makeGitUri(mergeBase, filePath);

        // Use workspace file for the right side when possible (gives IntelliSense)
        const headHash = await getHeadHash(cwd);
        const useWorkspaceFile =
          headCommit === UNCOMMITTED ||
          (headCommit === headHash &&
            !(await fileHasUncommittedChanges(cwd, filePath)));

        const rightUri = useWorkspaceFile
          ? vscode.Uri.joinPath(vscode.Uri.file(cwd), filePath)
          : makeGitUri(headCommit, filePath);
        if (useWorkspaceFile) {
          commentStore.addReviewFileUri(rightUri);
        }
        const title = `${filePath} (review)`;
        await vscode.commands.executeCommand(
          "vscode.diff",
          leftUri,
          rightUri,
          title
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.copyReview",
      async () => {
        const markdown = formatReviewForClipboard(commentStore);
        if (!markdown) {
          vscode.window.showInformationMessage(
            "No review comments to copy"
          );
          return;
        }
        await vscode.env.clipboard.writeText(markdown);
        const count = commentStore.getAllComments().length;
        vscode.window.showInformationMessage(
          `Copied ${count} review comment${count === 1 ? "" : "s"} to clipboard`
        );
      }
    )
  );

  // Clear all comments
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.clearComments",
      async () => {
        const answer = await vscode.window.showWarningMessage(
          "Clear all review comments?",
          { modal: true },
          "Clear"
        );
        if (answer === "Clear") {
          commentStore.clearAll();
        }
      }
    )
  );

  // Comment creation
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.createComment",
      (reply: vscode.CommentReply) => {
        const range =
          reply.thread.range ?? new vscode.Range(0, 0, 0, 0);

        let codeContext = "";
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === reply.thread.uri.toString()
        );
        if (doc) {
          codeContext = doc.getText(
            new vscode.Range(
              range.start.line,
              0,
              range.end.line,
              doc.lineAt(range.end.line).text.length
            )
          );
        }

        commentStore.addThread(
          reply.thread.uri,
          range,
          reply.text,
          codeContext
        );
        reply.thread.dispose();
      }
    )
  );

  // Comment deletion (from inline comment widget)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.deleteComment",
      (comment: vscode.Comment) => {
        commentStore.deleteThreadByComment(comment);
      }
    )
  );

  // Edit comment (switch to editing mode)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.editComment",
      (comment: vscode.Comment) => {
        const thread = commentStore.findThreadByComment(comment);
        if (thread) {
          commentStore.editComment(thread);
        }
      }
    )
  );

  // Save edited comment
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.saveEdit",
      (comment: vscode.Comment) => {
        const thread = commentStore.findThreadByComment(comment);
        if (thread) {
          commentStore.saveComment(thread, commentBody(comment));
        }
      }
    )
  );

  // Cancel edit
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.cancelEdit",
      (comment: vscode.Comment) => {
        const thread = commentStore.findThreadByComment(comment);
        if (thread) {
          commentStore.cancelEdit(thread);
        }
      }
    )
  );

  // Copy single comment from inline dialog
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.copyCommentInline",
      async (comment: vscode.Comment) => {
        const thread = commentStore.findThreadByComment(comment);
        if (!thread) return;
        const stored = commentStore.getCommentForThread(thread);
        if (!stored) return;
        await vscode.env.clipboard.writeText(
          formatSingleComment(commentStore, stored)
        );
        vscode.window.showInformationMessage(
          "Copied comment to clipboard"
        );
      }
    )
  );

  // Save comment and copy to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.createCommentAndCopy",
      async (reply: vscode.CommentReply) => {
        const range =
          reply.thread.range ?? new vscode.Range(0, 0, 0, 0);

        let codeContext = "";
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === reply.thread.uri.toString()
        );
        if (doc) {
          codeContext = doc.getText(
            new vscode.Range(
              range.start.line,
              0,
              range.end.line,
              doc.lineAt(range.end.line).text.length
            )
          );
        }

        const thread = commentStore.addThread(
          reply.thread.uri,
          range,
          reply.text,
          codeContext
        );
        reply.thread.dispose();

        const stored = commentStore.getCommentForThread(thread);
        if (stored) {
          await vscode.env.clipboard.writeText(
            formatSingleComment(commentStore, stored)
          );
          vscode.window.showInformationMessage(
            "Saved and copied comment to clipboard"
          );
        }
      }
    )
  );

  // Navigate to comment (from comments tree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.goToComment",
      async (item: { thread: vscode.CommentThread }) => {
        const uri = item.thread.uri;
        const range = item.thread.range;
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
          preview: true,
        });
        if (range) {
          editor.revealRange(
            range,
            vscode.TextEditorRevealType.InCenter
          );
          editor.selection = new vscode.Selection(
            range.start,
            range.start
          );
        }
      }
    )
  );

  // Delete comment (from comments tree trash icon)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.deleteCommentFromTree",
      (item: { thread: vscode.CommentThread }) => {
        commentStore.deleteThread(item.thread);
      }
    )
  );

  // Copy single comment (from comments tree clipboard icon)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.copyComment",
      async (item: { thread: vscode.CommentThread }) => {
        const comment =
          commentStore.getCommentForThread(item.thread);
        if (!comment) {
          return;
        }
        await vscode.env.clipboard.writeText(
          formatSingleComment(commentStore, comment)
        );
        vscode.window.showInformationMessage(
          "Copied comment to clipboard"
        );
      }
    )
  );

  // Initial load
  await commitsTree.refresh();
}

export function deactivate(): void {
  // cleanup handled by disposables
}

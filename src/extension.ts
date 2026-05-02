import * as vscode from "vscode";
import {
  fileHasUncommittedChanges,
  getHeadHash,
  getRepoRoot,
} from "./git";
import { UNCOMMITTED } from "./commitsTree";
import { GitContentProvider, makeGitUri } from "./gitContentProvider";
import { CommitsTreeProvider } from "./commitsTree";
import { FilesTreeProvider } from "./filesTree";
import { CommentsTreeProvider } from "./commentsTree";
import { CommentStore } from "./commentStore";
import { ApprovalStore } from "./approvalStore";
import {
  formatSingleComment,
  formatReviewForClipboard,
} from "./export";

const SELECTION_LOCKED_MSG =
  "Clear all comments before changing commit selection.";

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

  // Approval store
  const approvalStore = new ApprovalStore(context.workspaceState);
  context.subscriptions.push({
    dispose: () => approvalStore.dispose(),
  });

  // Tree providers
  const commitsTree = new CommitsTreeProvider(cwd, context.workspaceState);
  const filesTree = new FilesTreeProvider(cwd, approvalStore);

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
  });

  // Comments panel
  const commentsTree = new CommentsTreeProvider(commentStore);
  context.subscriptions.push(
    vscode.window.createTreeView("localReview.comments", {
      treeDataProvider: commentsTree,
    })
  );

  // Wire up checkbox changes -> file list updates (blocked when comments exist)
  commitsTreeView.onDidChangeCheckboxState((e) => {
    if (commentStore.hasComments()) {
      // Revert the change by refreshing the tree
      commitsTree.refreshTree();
      vscode.window.showWarningMessage(SELECTION_LOCKED_MSG);
      return;
    }
    commitsTree.handleCheckboxChange(e.items);
  });

  // Toggle commit via click (same lock logic as checkbox)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.toggleCommit",
      (item: { hash: string }) => {
        if (commentStore.hasComments()) {
          vscode.window.showWarningMessage(SELECTION_LOCKED_MSG);
          return;
        }
        commitsTree.toggleCommit(item.hash);
      }
    )
  );

  let currentDiffFilePath = "";

  commitsTree.onSelectionChanged(async (selectedHashes) => {
    const effectiveBase = commitsTree.getEffectiveBase();
    commentStore.setDiffContext({
      baseRevision: effectiveBase,
      headRevision: selectedHashes.length > 0 ? selectedHashes[0] : "",
    });
    await filesTree.updateFiles(selectedHashes, effectiveBase);

    // Re-open the current diff with the new base/head
    if (currentDiffFilePath) {
      await vscode.commands.executeCommand(
        "localReview.openDiff",
        currentDiffFilePath,
        effectiveBase,
        commentStore.diffContext.headRevision
      );
    }
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("localReview.selectAll", () => {
      if (commentStore.hasComments()) {
        vscode.window.showWarningMessage(SELECTION_LOCKED_MSG);
        return;
      }
      commitsTree.setAll(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localReview.deselectAll", () => {
      if (commentStore.hasComments()) {
        vscode.window.showWarningMessage(SELECTION_LOCKED_MSG);
        return;
      }
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
          ? vscode.Uri.file(`${cwd}/${filePath}`)
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

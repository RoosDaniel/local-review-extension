import * as vscode from "vscode";
import { getRepoRoot } from "./git";
import { GitContentProvider, makeGitUri } from "./gitContentProvider";
import { CommitsTreeProvider } from "./commitsTree";
import { FilesTreeProvider } from "./filesTree";
import { CommentsTreeProvider } from "./commentsTree";
import { CommentStore } from "./commentStore";
import { formatComment, formatReviewForClipboard } from "./export";

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Determine repo root from the first workspace folder
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
  const commentStore = new CommentStore();
  context.subscriptions.push({
    dispose: () => commentStore.dispose(),
  });

  // Tree providers
  const commitsTree = new CommitsTreeProvider(cwd);
  const filesTree = new FilesTreeProvider(cwd);

  const commitsTreeView = vscode.window.createTreeView(
    "localReview.commits",
    {
      treeDataProvider: commitsTree,
      manageCheckboxStateManually: true,
    }
  );
  context.subscriptions.push(commitsTreeView);

  context.subscriptions.push(
    vscode.window.createTreeView("localReview.files", {
      treeDataProvider: filesTree,
    })
  );

  // Comments panel
  const commentsTree = new CommentsTreeProvider(commentStore);
  context.subscriptions.push(
    vscode.window.createTreeView("localReview.comments", {
      treeDataProvider: commentsTree,
    })
  );

  // Wire up checkbox changes -> file list updates
  commitsTreeView.onDidChangeCheckboxState((e) => {
    commitsTree.handleCheckboxChange(e.items);
  });

  // Track the current diff's base/head so we can attach context to comments
  let currentDiffContext = { baseRevision: "", headRevision: "" };

  commitsTree.onSelectionChanged(async (selectedHashes) => {
    const effectiveBase = commitsTree.getEffectiveBase();
    currentDiffContext = {
      baseRevision: effectiveBase,
      headRevision: selectedHashes.length > 0 ? selectedHashes[0] : "",
    };
    await filesTree.updateFiles(selectedHashes, effectiveBase);
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("localReview.selectAll", () => {
      commitsTree.setAll(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("localReview.deselectAll", () => {
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
        currentDiffContext = {
          baseRevision: mergeBase,
          headRevision: headCommit,
        };
        const leftUri = makeGitUri(mergeBase, filePath);
        const rightUri = makeGitUri(headCommit, filePath);
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

  // Comment creation — triggered by the "Save Comment" button in the comment widget
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "localReview.createComment",
      (reply: vscode.CommentReply) => {
        const range =
          reply.thread.range ?? new vscode.Range(0, 0, 0, 0);

        // Capture the code at the commented range
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
          { ...currentDiffContext },
          codeContext
        );
        // Dispose the empty draft thread that VS Code created
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
        // Open the document and reveal the comment range
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
        await vscode.env.clipboard.writeText(formatComment(comment));
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

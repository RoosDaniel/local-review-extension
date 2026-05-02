# CLAUDE.md

## Overview

VS Code/Cursor extension for reviewing local git changes with inline comments. Exports reviews as XML to clipboard, optimized for pasting into AI coding assistants.

## Development

```bash
npm install
npm run compile          # or npm run watch
# Press F5 to launch Extension Development Host
```

## Build & Release

```bash
npx @vscode/vsce package
gh release create v<version> local-review-<version>.vsix --title "v<version>"
cursor --install-extension local-review-<version>.vsix
```

Always bump the version in `package.json` before packaging — don't reuse version numbers.

## Architecture

```
src/
├── extension.ts          # Entry point, wires everything together
├── git.ts                # Shell out to git CLI (commits, diffs, file content)
├── gitContentProvider.ts # TextDocumentContentProvider for local-review-git:// URIs
├── commitsTree.ts        # Sidebar: commit list with checkboxes
├── filesTree.ts          # Sidebar: changed files filtered by selected commits
├── commentsTree.ts       # Sidebar: comment list with navigate/copy/delete
├── commentStore.ts       # Comment state, thread tracking, CommentController
└── export.ts             # XML clipboard formatting
```

### Key VS Code APIs

- **CommentController** (`commentStore.ts`): Provides the inline comment UI on diff views. Thread tracking is manual — VS Code doesn't expose created threads, so we maintain our own array.
- **TreeDataProvider** (`commitsTree.ts`, `filesTree.ts`, `commentsTree.ts`): Sidebar panels. Commits tree uses `manageCheckboxStateManually: true` for contiguity enforcement.
- **TextDocumentContentProvider** (`gitContentProvider.ts`): Serves file content at git revisions via `local-review-git://<revision>/<path>` URIs.
- **vscode.diff command**: Opens the built-in diff editor between two URIs.

### Key Design Decisions

- **Single diff context**: All comments share one base..head range. Commit selection is locked once comments exist — user must clear comments before changing selection. This keeps the export unambiguous.
- **Contiguous commit selection**: Checkbox toggling auto-fills gaps to enforce a contiguous range.
- **Workspace file for IntelliSense**: When the right side of a diff is HEAD and the file has no uncommitted changes, we use the actual `file://` URI instead of a virtual one. This gives full language features (go-to-definition, hover, etc.).
- **Uncommitted changes**: Virtual entry at top of commit list. Uses `file://` URI for the right side, `git diff HEAD` for file list.
- **XML export format**: `<review base="" head="">` wrapping `<comment>` elements with `<code>` and `<body>` children. No XML escaping — LLMs handle raw code fine.
- **Persistence scoping**: `ApprovalStore` uses `globalState` keyed by root commit hash, so file review statuses are shared across worktrees of the same repo. Comments and commit selection use `workspaceState` since they're tied to a specific working directory's diff context.

## Code Style

- Small duplications (comment body extraction, URI parsing, line range formatting) exist across files and are intentional — extracting them into shared utilities would add more indirection than the ~3 duplicated lines justify at this codebase size.
- Keep the codebase flat and simple. Avoid abstractions until there's a clear third use case.

## VS Code Extension Patterns

- **Disposables**: All event listeners, tree providers, and stores must be registered with `context.subscriptions` or disposed explicitly. Event emitters created in classes need a `dispose()` method.
- **Event listener ownership**: When a class subscribes to another class's event in its constructor, store the returned `Disposable` and dispose it in the class's own `dispose()` method.
- **Async race conditions**: Async event handlers (e.g. `onSelectionChanged`) that update shared state should use a generation counter to discard stale callbacks.
- **URI construction**: Use `vscode.Uri.joinPath()` instead of string concatenation when building file URIs.
- **Git error logging**: Silent `catch` blocks in `git.ts` should log to the "Local Review" output channel (`log`) rather than swallowing errors.

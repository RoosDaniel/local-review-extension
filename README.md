# Local Review

VS Code/Cursor extension for reviewing local git changes with inline comments. Export reviews to clipboard as structured Markdown, optimized for pasting into AI coding assistants like Claude Code.

## Features

- **Commit picker** -- select which commits to review (checkboxes, contiguous range enforced)
- **Changed files** -- filtered by selected commits, click to open diff
- **Inline comments** -- add comments directly on the diff view via VS Code's comment UI
- **Comments panel** -- lists all comments, click to navigate, per-comment copy and delete
- **Clipboard export** -- copies all comments as Markdown with file path, line range, diff side, commit range, and code context

## Clipboard output format

````markdown
# src/git.ts:L15-L17 [new code] (abc1234..def5678)
```
const { stdout } = await execFileAsync("git", args, {
  cwd,
  maxBuffer: 10 * 1024 * 1024,
});
```
This buffer size seems excessive for most operations
````

## Usage

1. Open a git repo with commits ahead of main
2. Click the "Local Review" icon in the activity bar
3. Select commits to review (all selected by default)
4. Click files to open diffs
5. Click the `+` gutter icon to add comments, then "Save Comment"
6. Click the clipboard icon in the Comments panel header to copy all comments

## Development

```bash
npm install
# Press F5 in VS Code/Cursor to launch Extension Development Host
```

## Install as VSIX

```bash
npm install -g @vscode/vsce
vsce package
code --install-extension local-review-0.0.1.vsix
```

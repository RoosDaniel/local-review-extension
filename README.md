# Local Review

VS Code/Cursor extension for reviewing local git changes with inline comments. Export reviews to clipboard as structured XML, optimized for pasting into AI coding assistants like Claude Code.

## Features

### Inline comments for LLMs

Add review comments directly on diff views, then copy them to clipboard as structured XML ready to paste into Claude Code, Cursor, or any AI coding assistant. Comments include the code context, file path, line range, and which side of the diff they refer to.

### File approval tracking

Mark files as reviewed with per-commit granularity. Approval persists across sessions and commit selections: approve a file in commits [A, B], switch to [B, C], and files only touched by B stay approved.

## Clipboard output format

```xml
<review base="abc1234" head="def5678">
  <comment file="src/git.ts" lines="15-18" side="new">
    <code>
const { stdout } = await execFileAsync("git", args, {
  cwd,
  maxBuffer: 10 * 1024 * 1024,
});
    </code>
    <body>This buffer size seems excessive for most operations</body>
  </comment>
</review>
```

## Usage

1. Open a git repo with commits ahead of main
2. Click the "Local Review" icon in the activity bar
3. Select commits to review (all selected by default)
4. Click files to open diffs
5. Click the `+` gutter icon to add comments, then "Save Comment"
6. Mark files as reviewed via the checkbox in the file list
7. Click the clipboard icon in the Comments panel header to copy all comments

## Install

Download the latest `.vsix` from [Releases](https://github.com/RoosDaniel/local-review-extension/releases), then:

```bash
code --install-extension local-review-*.vsix
```

...or just ask your LLM to do it.

## Development

```bash
npm install
# Press F5 in VS Code/Cursor to launch Extension Development Host
```

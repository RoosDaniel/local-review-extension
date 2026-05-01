import { type StoredComment, CommentStore } from "./commentStore";

export function formatComment(comment: StoredComment): string {
  const range =
    comment.startLine === comment.endLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}-L${comment.endLine}`;

  const side = comment.side === "before" ? "old code" : "new code";

  const shortRev = (rev: string) =>
    rev === "uncommitted" ? rev : rev.slice(0, 7);
  const diffRange = `${shortRev(comment.baseRevision)}..${shortRev(comment.headRevision)}`;

  const lines: string[] = [];
  lines.push(
    `# ${comment.filePath}:${range} [${side}] (${diffRange})`
  );

  if (comment.codeContext) {
    lines.push("```");
    lines.push(comment.codeContext);
    lines.push("```");
  }

  lines.push(comment.body);
  return lines.join("\n");
}

export function formatReviewForClipboard(
  store: CommentStore
): string {
  const comments = store.getAllComments();

  if (comments.length === 0) {
    return "";
  }

  return comments.map(formatComment).join("\n\n");
}

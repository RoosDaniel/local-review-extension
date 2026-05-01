import {
  type DiffContext,
  type StoredComment,
  CommentStore,
} from "./commentStore";

function shortRev(rev: string): string {
  return rev === "uncommitted" ? rev : rev.slice(0, 7);
}

function formatHeader(ctx: DiffContext): string {
  const lines: string[] = [];
  lines.push(
    `# Review: ${shortRev(ctx.baseRevision)}..${shortRev(ctx.headRevision)}`
  );
  lines.push("");
  lines.push(
    `Comments marked **[old code]** refer to the base version (${shortRev(ctx.baseRevision)}).`
  );
  lines.push(
    `Comments marked **[new code]** refer to the changed version (${shortRev(ctx.headRevision)}).`
  );
  return lines.join("\n");
}

export { formatHeader };

export function formatComment(comment: StoredComment): string {
  const range =
    comment.startLine === comment.endLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}-L${comment.endLine}`;

  const side = comment.side === "before" ? "old code" : "new code";

  const lines: string[] = [];
  lines.push(`## ${comment.filePath}:${range} [${side}]`);

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

  const header = formatHeader(store.diffContext);
  const body = comments.map(formatComment).join("\n\n");

  return `${header}\n\n${body}`;
}

import {
  type DiffContext,
  type StoredComment,
  CommentStore,
} from "./commentStore";

function shortRev(rev: string): string {
  return rev === "uncommitted" ? rev : rev.slice(0, 7);
}

function formatLines(comment: StoredComment): string {
  return comment.startLine === comment.endLine
    ? `${comment.startLine}`
    : `${comment.startLine}-${comment.endLine}`;
}

function formatComment(
  comment: StoredComment,
  indent = "  "
): string {
  const side = comment.side === "before" ? "old" : "new";
  const lines: string[] = [];

  lines.push(
    `${indent}<comment file="${(comment.filePath)}" lines="${formatLines(comment)}" side="${side}">`
  );

  if (comment.codeContext) {
    lines.push(`${indent}  <code>`);
    lines.push((comment.codeContext));
    lines.push(`${indent}  </code>`);
  }

  lines.push(`${indent}  <body>${(comment.body)}</body>`);
  lines.push(`${indent}</comment>`);

  return lines.join("\n");
}

export function formatSingleComment(
  store: CommentStore,
  comment: StoredComment
): string {
  const ctx = store.diffContext;
  const lines: string[] = [];
  lines.push(
    `<review base="${shortRev(ctx.baseRevision)}" head="${shortRev(ctx.headRevision)}">`
  );
  lines.push(formatComment(comment));
  lines.push("</review>");
  return lines.join("\n");
}

export function formatReviewForClipboard(
  store: CommentStore
): string {
  const comments = store.getAllComments();

  if (comments.length === 0) {
    return "";
  }

  const ctx = store.diffContext;
  const lines: string[] = [];
  lines.push(
    `<review base="${shortRev(ctx.baseRevision)}" head="${shortRev(ctx.headRevision)}">`
  );
  for (const comment of comments) {
    lines.push(formatComment(comment));
  }
  lines.push("</review>");
  return lines.join("\n");
}

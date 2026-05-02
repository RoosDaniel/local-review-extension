import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

interface Commit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}

export const log = vscode.window.createOutputChannel("Local Review");

async function git(
  cwd: string,
  ...args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

export async function getMainBranch(cwd: string): Promise<string> {
  // Try common main branch names
  for (const name of ["main", "master"]) {
    try {
      await git(cwd, "rev-parse", "--verify", name);
      return name;
    } catch {
      // try next
    }
  }
  // Fall back to detecting via remote HEAD
  try {
    const ref = await git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

export async function getMergeBase(
  cwd: string,
  base: string
): Promise<string> {
  return git(cwd, "merge-base", base, "HEAD");
}

export async function getCommits(
  cwd: string,
  base: string
): Promise<Commit[]> {
  const SEP = "---LOCAL-REVIEW-SEP---";
  const format = [`%H`, `%h`, `%s`, `%an`, `%ad`].join(SEP);

  let output: string;
  try {
    output = await git(
      cwd,
      "log",
      `${base}..HEAD`,
      `--format=${format}`,
      "--date=short"
    );
  } catch {
    return [];
  }

  if (!output) {
    return [];
  }

  return output.split("\n").map((line) => {
    const [hash, shortHash, subject, author, date] = line.split(SEP);
    return { hash, shortHash, subject, author, date };
  });
}

export async function getChangedFiles(
  cwd: string,
  commitHashes: string[],
  mergeBase: string
): Promise<ChangedFile[]> {
  if (commitHashes.length === 0) {
    return [];
  }

  const fileMap = new Map<string, string>();

  for (const hash of commitHashes) {
    // Handle uncommitted changes separately
    if (hash === "uncommitted") {
      const uncommitted = await getUncommittedFiles(cwd);
      for (const file of uncommitted) {
        fileMap.set(file.path, file.status);
      }
      continue;
    }

    let output: string;
    try {
      output = await git(
        cwd,
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        hash
      );
    } catch (err) {
      log.appendLine(`git diff-tree failed for ${hash}: ${err}`);
      continue;
    }

    if (!output) {
      continue;
    }

    for (const line of output.split("\n")) {
      const match = line.match(/^([AMDRC])\t(.+)$/);
      if (match) {
        fileMap.set(match[2], match[1]);
      }
    }
  }

  return Array.from(fileMap.entries())
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Returns which commits touched each file: filePath -> set of commit hashes. */
export async function getFileCommitMap(
  cwd: string,
  commitHashes: string[]
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();

  for (const hash of commitHashes) {
    let files: string[];
    if (hash === "uncommitted") {
      const uncommitted = await getUncommittedFiles(cwd);
      files = uncommitted.map((f) => f.path);
    } else {
      try {
        const output = await git(
          cwd,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          hash
        );
        files = output ? output.split("\n") : [];
      } catch (err) {
        log.appendLine(`git diff-tree failed for ${hash}: ${err}`);
        continue;
      }
    }

    for (const file of files) {
      const set = result.get(file) ?? new Set();
      set.add(hash);
      result.set(file, set);
    }
  }

  return result;
}

export async function getFileAtRevision(
  cwd: string,
  revision: string,
  filePath: string
): Promise<string> {
  try {
    return await git(cwd, "show", `${revision}:${filePath}`);
  } catch {
    // File didn't exist at this revision (e.g. newly added)
    return "";
  }
}

export async function hasUncommittedChanges(
  cwd: string
): Promise<boolean> {
  try {
    const output = await git(cwd, "status", "--porcelain");
    return output.length > 0;
  } catch {
    return false;
  }
}

export async function getUncommittedFiles(
  cwd: string
): Promise<ChangedFile[]> {
  const fileMap = new Map<string, string>();

  // Staged + unstaged changes vs HEAD
  let output: string;
  try {
    output = await git(cwd, "diff", "--name-status", "HEAD");
  } catch {
    // No HEAD yet (empty repo), try against empty tree
    try {
      output = await git(
        cwd,
        "diff",
        "--name-status",
        "--cached"
      );
    } catch (err) {
      log.appendLine(`git diff --cached failed: ${err}`);
      return [];
    }
  }

  if (output) {
    for (const line of output.split("\n")) {
      const match = line.match(/^([AMDRC])\t(.+)$/);
      if (match) {
        fileMap.set(match[2], match[1]);
      }
    }
  }

  // Also pick up untracked files
  try {
    const untracked = await git(
      cwd,
      "ls-files",
      "--others",
      "--exclude-standard"
    );
    if (untracked) {
      for (const path of untracked.split("\n")) {
        fileMap.set(path, "A");
      }
    }
  } catch {
    // ignore
  }

  return Array.from(fileMap.entries())
    .map(([path, status]) => ({ path, status }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function getHeadHash(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "HEAD");
}

export async function fileHasUncommittedChanges(
  cwd: string,
  filePath: string
): Promise<boolean> {
  try {
    const output = await git(
      cwd,
      "diff",
      "--name-only",
      "HEAD",
      "--",
      filePath
    );
    return output.length > 0;
  } catch {
    return true; // assume dirty if we can't tell
  }
}

export async function getRepoRoot(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

/** Returns the root commit hash — a stable identity shared across all worktrees/branches. */
export async function getRepoId(cwd: string): Promise<string> {
  return git(cwd, "rev-list", "--max-parents=0", "HEAD");
}

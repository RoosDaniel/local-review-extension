import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

  // Get files changed in each selected commit individually (not cumulative)
  const fileMap = new Map<string, string>();

  for (const hash of commitHashes) {
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
    } catch {
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

export async function getRepoRoot(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}

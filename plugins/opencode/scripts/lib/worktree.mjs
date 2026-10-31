import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { runCommand } from "./process.mjs";
import { updateState } from "./state.mjs";
import { workspaceKey } from "./workspace-key.mjs";

function worktreeRoot(workspace) {
  const key = workspaceKey(workspace);
  return path.join(process.env.OPENCODE_WORKTREE_ROOT ?? path.join(os.tmpdir(), "opencode-worktrees"), key);
}

function samePath(a, b) {
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; }
}

function ownedPath(workspace, target) {
  try {
    const relative = path.relative(fs.realpathSync.native(worktreeRoot(workspace)), fs.realpathSync.native(target));
    return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  } catch { return false; }
}

// Never force-remove a worktree: uncommitted job output belongs to the user.
export async function releaseWorktree(workspace, job) {
  if (!job?.worktreePath) return undefined;
  const target = job.worktreePath;
  if (!ownedPath(workspace, target)) throw new Error(`Refusing worktree cleanup outside plugin root: ${target}`);
  const dirty = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: target, incidentLog: job.incidentLog });
  if (dirty.exitCode !== 0) return "retained";
  if (dirty.stdout.trim()) return "retained";
  // Preserve a short caller-supplied path (e.g. a Windows drive alias).
  // Discovery otherwise expands it before worktree remove spawns git status.
  const common = await runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: workspace, incidentLog: job.incidentLog });
  if (common.exitCode !== 0) return "retained";
  const gitDir = path.relative(workspace, path.resolve(workspace, common.stdout.trim())) || ".";
  const removed = await runCommand("git", ["--git-dir", gitDir, "worktree", "remove", target], { cwd: workspace, incidentLog: job.incidentLog });
  if (removed.exitCode !== 0) return "retained";
  return "removed";
}

export async function createWorktree(workspace, branch, jobId) {
  const valid = await runCommand("git", ["check-ref-format", "--branch", branch], { cwd: workspace });
  if (valid.exitCode !== 0 || branch.startsWith("-")) throw new Error(`Invalid worktree branch: ${branch}`);
  // Deep plugin cache/data paths can exceed Git for Windows' GIT_DIR limit.
  // Git for Windows also limits the UTF-8 length of its worktree admin path.
  const directory = crypto.createHash("sha256").update(jobId).digest("hex").slice(0, 12);
  const target = path.join(worktreeRoot(workspace), directory);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const listed = await runCommand("git", ["worktree", "list", "--porcelain", "-z"], { cwd: workspace });
  if (listed.exitCode !== 0) throw new Error(listed.stderr || listed.stdout);
  let registered;
  for (const field of listed.stdout.split("\0")) {
    if (field.startsWith("worktree ")) registered = field.slice(9);
    if (field === `branch refs/heads/${branch}` && ownedPath(workspace, registered)) {
      // Claim retained output before returning so another job cannot reuse it.
      updateState(workspace, (state) => {
        const owners = (state.jobs ?? []).filter((job) => job.worktreePath && samePath(job.worktreePath, registered));
        if (owners.some((job) => !["completed", "failed", "cancelled"].includes(job.status))) throw new Error(`Worktree branch ${branch} belongs to an active job`);
        if (!owners.length) throw new Error(`Worktree branch ${branch} has no completed owner; inspect it manually`);
        const claim = state.jobs.find((job) => job.id === jobId);
        const meta = { status: "running", worktreePath: registered, worktreeBranch: branch };
        if (claim) Object.assign(claim, meta); else state.jobs.push({ id: jobId, ...meta });
      });
      return { path: registered, branch, reused: true };
    }
  }
  const existing = await runCommand("git", ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`], { cwd: workspace });
  if (existing.exitCode !== 0) throw new Error(existing.stderr);
  const branchExists = existing.stdout.split(/\r?\n/).includes(`refs/heads/${branch}`);
  const args = ["-c", "core.longpaths=true", "worktree", "add", ...(branchExists ? [] : ["-b", branch]), target, ...(branchExists ? [branch] : ["HEAD"])];
  const result = await runCommand("git", args, { cwd: workspace });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return { path: target, branch, command: { command: `git ${args.join(" ")}`, exitCode: result.exitCode } };
}

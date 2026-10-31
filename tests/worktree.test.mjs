import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { createWorktree } from "../plugins/opencode/scripts/lib/worktree.mjs";
import { createJobRecord, runTrackedJob } from "../plugins/opencode/scripts/lib/tracked-jobs.mjs";
import { upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";

it("creates isolated worktrees in Unicode paths and rejects invalid branches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree tiếng Việt "));
  const old = process.env.OPENCODE_COMPANION_DATA;
  const oldRoot = process.env.OPENCODE_WORKTREE_ROOT;
  process.env.OPENCODE_WORKTREE_ROOT = path.join(dir, "cây công việc");
  process.env.OPENCODE_COMPANION_DATA = path.join(dir, "dữ liệu");
  try {
    await runCommand("git", ["init", dir]);
    await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"], { cwd: dir });
    const result = await createWorktree(dir, "job-one", "one");
    assert.equal(result.command.exitCode, 0);
    fs.writeFileSync(path.join(result.path, "hello.txt"), "hello");
    assert.equal(fs.existsSync(path.join(dir, "hello.txt")), false);
    const second = await createWorktree(dir, "job-two", "two");
    assert.notEqual(result.path, second.path);
    await assert.rejects(createWorktree(dir, "--bad", "bad"), /Invalid worktree branch/);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COMPANION_DATA; else process.env.OPENCODE_COMPANION_DATA = old;
    if (oldRoot === undefined) delete process.env.OPENCODE_WORKTREE_ROOT; else process.env.OPENCODE_WORKTREE_ROOT = oldRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("releases clean worktrees on success and startup failure, preserves and reuses dirty output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
  const old = process.env.OPENCODE_COMPANION_DATA, oldRoot = process.env.OPENCODE_WORKTREE_ROOT;
  process.env.OPENCODE_COMPANION_DATA = path.join(dir, "data");
  process.env.OPENCODE_WORKTREE_ROOT = path.join(dir, "trees");
  try {
      await runCommand("git", ["init", dir]);
      await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"], { cwd: dir });
      for (const throws of [false, true]) {
        const job = createJobRecord(dir, "task");
        const tree = await createWorktree(dir, "clean-branch", job.id);
        upsertJob(dir, { id: job.id, worktreePath: tree.path });
        const outcome = await runTrackedJob(dir, job, async () => {
          if (throws) throw new Error("Startup failed");
          return {};
        });
        assert.equal(fs.existsSync(tree.path), false, JSON.stringify(outcome));
        assert.equal(outcome.digest.worktreeStatus, "removed");
      }
      const job = createJobRecord(dir, "task");
      const tree = await createWorktree(dir, "dirty-branch", job.id);
      upsertJob(dir, { id: job.id, worktreePath: tree.path });
      const outcome = await runTrackedJob(dir, job, async () => {
        fs.writeFileSync(path.join(tree.path, "keep.txt"), "user-owned output");
        return { changedFiles: ["keep.txt"] };
      });
      assert.equal(outcome.digest.worktreeStatus, "retained");
      const equivalent = process.platform === "win32" ? dir.replaceAll("\\", "/").toUpperCase() : dir;
      const reused = await createWorktree(equivalent, "dirty-branch", "next-job");
      assert.equal(fs.realpathSync.native(reused.path), fs.realpathSync.native(tree.path));
      assert.equal(fs.readFileSync(path.join(reused.path, "keep.txt"), "utf8"), "user-owned output");
      upsertJob(dir, { id: "next-job", status: "running", worktreePath: reused.path });
      await assert.rejects(createWorktree(dir, "dirty-branch", "competing-job"), /active job/);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COMPANION_DATA; else process.env.OPENCODE_COMPANION_DATA = old;
    if (oldRoot === undefined) delete process.env.OPENCODE_WORKTREE_ROOT; else process.env.OPENCODE_WORKTREE_ROOT = oldRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

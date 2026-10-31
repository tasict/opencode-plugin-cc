import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeDigest, collectTelemetry } from "../plugins/opencode/scripts/lib/digest.mjs";
import { createJobRecord, runTrackedJob } from "../plugins/opencode/scripts/lib/tracked-jobs.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

it("classifies permission denial phrases without matching ordinary confirmation or permission names", () => {
  for (const message of ["ConfirmationDialog failed", "confirm password mismatch", "approvalTests failed", "interactive shell test failed", "permission parser failed", "denied.json missing"]) {
    assert.equal(makeDigest({ result: { error: message, exitCode: 1 } }).status, "failed", message);
    assert.equal(makeDigest({ result: { raw: { type: "error", error: { message } } } }).status, "failed", message);
  }
  for (const message of ["Permission denied", "approval required", "tool needs interactive input", "blocked by organization policy", "Full access blocked by agent plan permission deny"]) {
    assert.equal(makeDigest({ error: new Error(message) }).status, "blocked", message);
    assert.equal(collectTelemetry({ type: "error", error: { message } }).blocked, true, message);
  }
});

it("keeps harness probes in full logs and only agent tool commands in the digest", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-digest-"));
  const old = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = dir;
  try {
    const result = await runTrackedJob(dir, createJobRecord(dir, "task"), async () => {
      await runCommand(process.execPath, ["--version"]);
      return { raw: { tool: "shell", state: { input: { command: "npm test" }, metadata: { exit: 0 } } } };
    });
    assert.deepEqual(result.digest.commandsRun, [{ command: "npm test", exitCode: 0 }]);
    assert.match(fs.readFileSync(result.digest.logPath, "utf8"), /--version/);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COMPANION_DATA; else process.env.OPENCODE_COMPANION_DATA = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("review digests retain bounded assistant findings and verdict", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-digest-"));
  const old = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = dir;
  try {
    for (const type of ["review", "adversarial-review"]) {
      const text = JSON.stringify({ verdict: "needs-attention", findings: [{ file: "api.js", line: 12, severity: "high", body: "Null input crashes" }] });
      const result = await runTrackedJob(dir, createJobRecord(dir, type), async () => ({ messages: JSON.stringify({ type: "text", part: { type: "text", text } }) }));
      assert.equal(result.digest.reviewOutput, text);
      assert.equal(result.digest.reviewOutputTruncated, false);
    }
    const large = makeDigest({ jobType: "review", result: { messages: [{ role: "user", parts: [{ type: "text", text: "secret prompt" }] }, { role: "assistant", parts: [{ type: "text", text: "x".repeat(10000) }] }] } });
    assert.equal(large.reviewOutput.length, 8000);
    assert.equal(large.reviewOutputTruncated, true);
    assert.equal(makeDigest({ result: { rendered: "task text" } }).reviewOutput, undefined);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COMPANION_DATA; else process.env.OPENCODE_COMPANION_DATA = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("digest extracts commands and exit codes, bounds failures and distinguishes blocked", () => {
  const result = { changedFiles: ["hello.txt"], raw: { parts: [{ type: "tool", tool: "shell", state: { input: { command: "npm test" }, metadata: { exit: 7 }, error: Array(80).fill("original failure").join("\n") } }] } };
  const digest = makeDigest({ result, logPath: "full.log" });
  assert.equal(digest.status, "failed");
  assert.equal(digest.commandsRun[0].exitCode, 7);
  assert.equal(digest.testsSummary.failed, 1);
  assert.equal(digest.failures.length, 40);
  assert.equal(makeDigest({ error: new Error("Permission denied") }).status, "blocked");
});

it("reads real v2 nested command exit metadata and preserves command failure output", () => {
  const digest = makeDigest({ result: { raw: { part: { type: "tool", tool: "shell", state: { input: { command: "git status" }, metadata: { metadata: { exit: 9 } }, output: "original git error" } } } } });
  assert.equal(digest.commandsRun[0].exitCode, 9);
  assert.equal(digest.status, "failed");
  assert.deepEqual(digest.failures, ["original git error"]);
  assert.deepEqual(collectTelemetry({ part: { tool: "write", state: { status: "completed", input: { path: "outside-workspace.txt" } } } }).files, ["outside-workspace.txt"]);
});

it("tracked jobs persist digest for successful and failed jobs with full logs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest tiếng Việt "));
  const old = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = dir;
  try {
    const job = createJobRecord(dir, "task");
    const result = await runTrackedJob(dir, job, async ({ log }) => { log("full detail"); return { rendered: "done", changedFiles: ["hello.txt"] }; });
    assert.equal(result.digest.status, "passed");
    assert.match(fs.readFileSync(result.digest.logPath, "utf8"), /full detail/);
    const fail = await runTrackedJob(dir, createJobRecord(dir, "task"), async () => { throw new Error("Provider failed"); });
    assert.equal(fail.digest.status, "error");
    assert.deepEqual(fail.digest.failures, ["Provider failed"]);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COMPANION_DATA; else process.env.OPENCODE_COMPANION_DATA = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

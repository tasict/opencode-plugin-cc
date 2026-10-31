import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { incident } from "../plugins/opencode/scripts/lib/incidents.mjs";
import { runCommand, commandContext } from "../plugins/opencode/scripts/lib/process.mjs";
import { createJobRecord, runTrackedJob } from "../plugins/opencode/scripts/lib/tracked-jobs.mjs";

it("records one bounded incident per failure event without duplicating command traces", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "incident-events-"));
  const old = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = dir;
  const file = path.join(dir, "incidents.md");
  try {
    const trace = Array.from({ length: 80 }, (_, i) => `failure line ${i}`).join("\n");
    await runTrackedJob(dir, createJobRecord(dir, "task", { incidentLog: file }), async () => ({ error: trace, exitCode: 1 }));
    let text = fs.readFileSync(file, "utf8");
    assert.equal((text.match(/^## /gm) ?? []).length, 1);
    assert.ok(text.includes("failure line 39"));
    assert.ok(!text.includes("failure line 40"));
    fs.writeFileSync(file, "");
    await runTrackedJob(dir, createJobRecord(dir, "task", { incidentLog: file }), async () => {
      const response = await runCommand(process.execPath, ["-e", "process.stderr.write('original trace\\nsecond line');process.exit(7)"]);
      return { error: response.stderr, exitCode: response.exitCode };
    });
    text = fs.readFileSync(file, "utf8");
    assert.equal((text.match(/^## /gm) ?? []).length, 1);
    assert.match(text, /original trace\nsecond line/);
    fs.writeFileSync(file, "");
    await runTrackedJob(dir, createJobRecord(dir, "task", { incidentLog: file }), async () => {
      const event = JSON.stringify({ type: "tool", tool: "shell", state: { input: { command: "npm test" }, metadata: { exit: 7 }, output: "original tool failure\nsecond tool line" } });
      const response = await runCommand(process.execPath, ["-e", "process.stdout.write(process.argv[1]);process.exit(7)", event]);
      return { messages: response.stdout, error: "original tool failure\nsecond tool line", exitCode: 7 };
    });
    text = fs.readFileSync(file, "utf8");
    assert.equal((text.match(/^## /gm) ?? []).length, 1);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COMPANION_DATA; else process.env.OPENCODE_COMPANION_DATA = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("appends incidents for blocked requests, failed commands, timeouts and process kills", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "incident tiếng Việt "));
  const file = path.join(dir, "log.md");
  try {
    incident(file, "blocked", "shell request", "Permission denied", "Stop job");
    const commands = [];
    await commandContext.run({ commands, incidentLog: file }, async () => {
      await runCommand(process.execPath, ["-e", "process.stderr.write('original error'); process.exit(7)"]);
      const result = await runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 });
      assert.equal(result.exitCode, 124);
    });
    assert.deepEqual(commands.map((c) => c.exitCode), [7, 124]);
    const text = fs.readFileSync(file, "utf8");
    for (const value of ["blocked", "command_failed", "timeout", "killed_process", "original error", "Permission denied"]) assert.ok(text.includes(value), value);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

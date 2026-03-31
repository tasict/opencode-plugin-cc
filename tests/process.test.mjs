import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

describe("process", () => {
  it("runCommand captures stdout", async () => {
    const { stdout, exitCode } = await runCommand("echo", ["hello"]);
    assert.equal(stdout.trim(), "hello");
    assert.equal(exitCode, 0);
  });

  it("runCommand captures exit code on failure", async () => {
    const { exitCode } = await runCommand("false", []);
    assert.notEqual(exitCode, 0);
  });

  it("runCommand captures stderr", async () => {
    const { stderr, exitCode } = await runCommand("sh", ["-c", "echo err >&2"]);
    assert.ok(stderr.includes("err"));
  });
});

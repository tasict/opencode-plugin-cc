import { it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

const hook = fileURLToPath(new URL("../plugins/opencode/scripts/post-tool-use-monitor-hook.mjs", import.meta.url));
it("monitor ignores task-resume-candidate source text and accepts JSON job launches", async () => {
  const ignored = await runCommand(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_response: "opencode-companion.mjs task-resume-candidate" }) });
  assert.equal(ignored.stdout, "");
  const launch = await runCommand(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_response: { jobId: "task-mvpl5dgx-fr6rd3", status: "running", pid: 123 } }) });
  const context = JSON.parse(launch.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /done\|completed\|failed/);
  assert.match(context, /task-mvpl5dgx-fr6rd3/);
});

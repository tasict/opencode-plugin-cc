import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { npmCmdShim } from "./helpers.mjs";

const companion = fileURLToPath(new URL("../plugins/opencode/scripts/opencode-companion.mjs", import.meta.url));
const fixture = `import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version') console.log('opencode v2.1.4');
else if(args.includes('--help')) console.log('--auto --standalone');
else if(args[0]==='debug') console.log(JSON.stringify(args[1]==='config'?[]:[{id:'build',permissions:[]},{id:'plan',permissions:[{action:'edit',effect:'deny'}]}]));
else if(args[0]==='auth') console.log('Default stored credentials');
else if(args[0]==='models') console.log('opencode-go/flash\\nopencode/flash');
else if(args[0]==='run') {
 let input=''; for await(const chunk of process.stdin) input+=chunk;
 if(process.env.CAPTURE) fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,input,cwd:process.cwd(),pwd:process.env.PWD}));
 if(process.env.SLOW_JOB) await new Promise(()=>setInterval(()=>{},1000));
 if(process.env.FAIL_PROVIDER) { console.log(JSON.stringify({type:'error',error:{message:'Policy budget exceeded'}})); process.exit(1); }
 fs.writeFileSync('hello.txt','hello');
 console.log(JSON.stringify({type:'tool_use',sessionID:'ses_fake',part:{id:'part1',type:'tool',tool:'shell',state:{status:'completed',input:{command:'git status'},metadata:{exit:0},output:'?? hello.txt'}}}));
 console.log(JSON.stringify({type:'text',part:{type:'text',text:process.env.REVIEW_TEXT ?? 'done'}}));
}
`;

it("background CLI jobs preserve model variant and stdin, isolate worktrees, expose cheap status and JSON results", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ủy quyền tiếng Việt "));
  const bin = path.join(dir, "bin"), repo = path.join(dir, "repo có dấu"), data = path.join(dir, "state");
  fs.mkdirSync(bin); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(bin, "fake.mjs"), fixture);
  fs.writeFileSync(path.join(bin, "opencode.cmd"), npmCmdShim("fake.mjs"));
  fs.writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${path.join(bin, "fake.mjs").replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, OPENCODE_COMPANION_DATA: data, OPENCODE_WORKTREE_ROOT: path.join(dir, "worktrees"), CAPTURE: path.join(dir, "capture.json") };
  const call = (args, opts = {}) => runCommand(process.execPath, [companion, ...args], { cwd: repo, env, ...opts });
  try {
    await runCommand("git", ["init", repo]);
    await runCommand("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"], { cwd: repo });
    const setup = await call(["setup", "--json"]);
    assert.equal(setup.exitCode, 0, setup.stderr);
    assert.deepEqual(JSON.parse(setup.stdout).providers, ["opencode-go", "opencode"]);
    const configured = JSON.parse((await call(["setup", "--json", "--full-access", "true", "--repair-config", "false"])).stdout);
    assert.equal(configured.userConfig.full_access, true);
    assert.equal(configured.userConfig.repair_config, false);
    await t.test("text modes reach status and review renderers while JSON remains the default", async () => {
      const empty = await call(["status", "--text"]);
      assert.match(empty.stdout, /No OpenCode jobs/);
      const review = JSON.stringify({ verdict: "needs-attention", summary: "Fix null handling", findings: [{ file: "api.js", line_start: 2, line_end: 3, severity: "high", title: "Null crash", body: "Null input crashes", confidence: 0.9, recommendation: "Validate input" }] });
      for (const type of ["review", "adversarial-review"]) {
        const output = await call([type, "--text"], { env: { ...env, REVIEW_TEXT: review } });
        assert.equal(output.exitCode, 0, output.stdout + output.stderr);
        assert.match(output.stdout, /Review Verdict: NEEDS ATTENTION/);
        assert.match(output.stdout, /api.js:2-3/);
      }
      const status = await call(["status", "--text"]);
      assert.match(status.stdout, /Latest Finished/);
      const json = await call(["review", "--text", "--json"]);
      assert.equal(JSON.parse(json.stdout).status, "passed");
      const plain = await call(["review", "--text"]);
      assert.equal(plain.stdout.trim(), "done");
      fs.unlinkSync(path.join(repo, "hello.txt"));
    });
    await t.test("full-access reviews and read-only tasks default to build without overriding explicit agents", async () => {
      for (const args of [["review"], ["adversarial-review"], ["task", "--read-only", "inspect"]]) {
        const result = await call(args);
        assert.equal(result.exitCode, 0, result.stdout + result.stderr);
        assert.equal(JSON.parse(result.stdout).status, "passed");
        const capture = JSON.parse(fs.readFileSync(env.CAPTURE));
        assert.equal(capture.args[capture.args.indexOf("--agent") + 1], "build");
      }
      const explicit = await call(["review", "--agent", "plan"]);
      assert.equal(JSON.parse(explicit.stdout).status, "blocked");
      const normal = await call(["review", "--no-full-access"]);
      assert.equal(normal.exitCode, 0, normal.stdout + normal.stderr);
      const capture = JSON.parse(fs.readFileSync(env.CAPTURE));
      assert.equal(capture.args[capture.args.indexOf("--agent") + 1], "plan");
      fs.unlinkSync(path.join(repo, "hello.txt"));
    });
    const prompt = 'a "b" & c | d % é tiếng Việt';
    const start = await call(["task", "--arguments-stdin"], { input: JSON.stringify(["--background", "--full-access", "--model", "opencode-go/flash#max", "--worktree", "test-job", "--incident-log", path.join(dir,"incidents.md"), prompt]) });
    assert.equal(start.exitCode, 0, start.stderr);
    const jobId = JSON.parse(start.stdout).jobId;
    let status;
    for(let i=0;i<100;i++) {
      const result = await call(["status", jobId, "--json"]);
      status = JSON.parse(result.stdout).job;
      assert.ok(result.stdout.length < 500);
      assert.equal(status.progressPreview, undefined);
      if(status.status !== 'running') break;
      await new Promise((resolve)=>setTimeout(resolve,100));
    }
    assert.equal(status.status, "done", (await call(["result", jobId])).stdout);
    assert.ok(status.pid > 0); assert.ok(status.lastOutputAt);
    const result = await call(["result", jobId]);
    const digest = JSON.parse(result.stdout);
    assert.equal(digest.status, "passed");
    assert.deepEqual(digest.filesChanged, ["hello.txt"]);
    assert.ok(digest.commandsRun.some((c)=>c.command==='git status' && c.exitCode===0));
    assert.equal(fs.existsSync(path.join(repo,"hello.txt")),false);
    assert.equal(fs.readFileSync(path.join(digest.worktreePath,"hello.txt"),"utf8"),'hello');
    const capture = JSON.parse(fs.readFileSync(env.CAPTURE));
    assert.ok(capture.input.includes(prompt));
    assert.ok(capture.args.includes("opencode-go/flash#max"));
    assert.ok(capture.args.includes("--auto"));
    assert.ok(capture.args.includes("--standalone"));
    assert.equal(capture.pwd, capture.cwd);
    assert.equal(capture.args.some((x)=>x.includes(prompt)),false);
    fs.unlinkSync(digest.logPath.replace(/\.log$/, ".json"));
    assert.deepEqual(JSON.parse((await call(["result", jobId])).stdout), digest);
    const badModel = await call(["task", "--model", "opencode/missing", "test"]);
    assert.equal(JSON.parse(badModel.stdout).status, "error");
    assert.match(JSON.parse(badModel.stdout).failures.join("\n"), /Model not found/);
    const budget = await call(["task", "--model", "opencode/flash#max", "test"], { env: { ...env, FAIL_PROVIDER: "1" } });
    const failure = JSON.parse(budget.stdout);
    assert.equal(failure.status, "failed");
    assert.match(failure.failures.join("\n"), /Policy budget exceeded/);
    assert.match(failure.failures.join("\n"), /opencode-go\/flash#max/);
    const incidentFile = path.join(dir, "cancel-incidents.md");
    const slowStart = await call(["task", "--background", "--worktree", "cancelled-job", "--incident-log", incidentFile, "slow"], { env: { ...env, SLOW_JOB: "1" } });
    const slowId = JSON.parse(slowStart.stdout).jobId;
    for (let i = 0; i < 100; i++) {
      const slow = JSON.parse((await call(["status", slowId, "--json"])).stdout).job;
      if (slow.agentPid) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cancel = await call(["cancel", slowId]);
    assert.equal(cancel.exitCode, 0, cancel.stdout + cancel.stderr);
    assert.equal(JSON.parse(cancel.stdout).status, "failed");
    const cancelled = JSON.parse(cancel.stdout);
    assert.ok(["removed", "retained"].includes(cancelled.worktreeStatus));
    assert.equal(fs.existsSync(cancelled.worktreePath), cancelled.worktreeStatus === "retained");
    assert.equal(JSON.parse((await call(["result", slowId])).stdout).status, "failed");
    assert.match(fs.readFileSync(incidentFile, "utf8"), /killed_process/);
    const retry = await call(["task", "--worktree", "cancelled-job", "retry"]);
    assert.equal(retry.exitCode, 0, retry.stdout + retry.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); }
});

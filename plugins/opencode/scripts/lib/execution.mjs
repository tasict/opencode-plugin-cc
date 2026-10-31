import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runCommand } from "./process.mjs";
import { createWorktree } from "./worktree.mjs";
import { prepareAccess } from "./access.mjs";
import { discoverProviders, validateModel, providerError } from "./providers.mjs";
import { collectTelemetry } from "./digest.mjs";
import { upsertJob } from "./state.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./prompts.mjs";

export async function dirtySnapshot(cwd) {
  const result = await runCommand("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  const entries = result.stdout.split("\0").filter(Boolean), hashes = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], file = entry.slice(3);
    if (/R|C/.test(entry.slice(0, 2))) i++;
    try { hashes[file] = crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, file))).digest("hex"); }
    catch { hashes[file] = "deleted"; }
  }
  return hashes;
}

export async function executeCliJob(workspace, job, request, { report, log }, pluginRoot) {
  let cwd = workspace;
  if (request.worktree) {
    const tree = await createWorktree(workspace, request.worktree, job.id);
    cwd = tree.path;
    upsertJob(workspace, { id: job.id, worktreePath: cwd, worktreeBranch: tree.branch });
  }
  const version = await runCommand("opencode", ["--version"], { cwd, timeoutMs: 15_000 });
  const major = Number(version.stdout.match(/v?(\d+)\./)?.[1]);
  if (version.exitCode !== 0 || ![1, 2].includes(major)) throw new Error(`Unsupported or missing OpenCode CLI: ${version.stderr || version.stdout}`);
  const access = await prepareAccess({ fullAccess: request.fullAccess, repairConfig: request.repairConfig, major, cwd, agent: request.agent });
  upsertJob(workspace, { id: job.id, configChanges: access.configChanges, accessMode: access.mode ?? "configured permissions" });
  let models = [];
  if (request.model) {
    const discovery = await discoverProviders({ major, cwd });
    models = discovery.models;
    validateModel(request.model, models);
  }
  const before = await dirtySnapshot(cwd);
  const prompt = request.type === "task" ? buildTaskPrompt(request.taskText, { write: request.isWrite })
    : await buildReviewPrompt(cwd, { base: request.base, adversarial: request.type === "adversarial-review", focus: request.taskText }, pluginRoot);
  const args = ["run", "--format", "json", "--agent", request.agent, ...access.flags];
  if (major >= 2 && (request.standalone || request.fullAccess)) args.push("--standalone");
  if (major === 1 && request.standalone) throw new Error("--standalone requires OpenCode 2; OpenCode 1 run already owns its server");
  if (request.model) args.push("--model", request.model);
  if (request.resumeSessionId) args.push("--session", request.resumeSessionId);
  report("running", "OpenCode CLI running; full output is in the job log");
  const response = await runCommand("opencode", args, {
    cwd, env: access.env, input: `Job working directory: ${cwd}\nUse this directory for all file writes and repository operations.\n\n` + prompt + "\n\nWork autonomously; do not ask interactive questions. Report actual commands and test outcomes.\n",
    timeoutMs: request.timeoutMs ?? Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS || 14_400_000),
    onSpawn: (child) => upsertJob(workspace, { id: job.id, agentPid: child.pid }),
    onOutput: (chunk) => log(chunk),
  });
  const telemetry = collectTelemetry(response.stdout);
  const sessionEvent = response.stdout.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((event) => event?.sessionID);
  if (sessionEvent) upsertJob(workspace, { id: job.id, opencodeSessionId: sessionEvent.sessionID });
  const after = await dirtySnapshot(cwd);
  const gitChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
  const observedWrites = telemetry.files.map((file) => {
    const absolute = path.resolve(cwd, file), relative = path.relative(cwd, absolute);
    return relative.startsWith(".." + path.sep) || path.isAbsolute(relative) ? absolute : relative.replaceAll(path.sep, "/");
  });
  const changedFiles = [...new Set([...gitChanges, ...observedWrites])];
  if (response.exitCode !== 0 || telemetry.failures.length) {
    const error = providerError(new Error(telemetry.failures.join("\n") || response.stderr || response.stdout || `OpenCode exited ${response.exitCode}`), request.model, models);
    // Preserve all observed commands and changed files even when CLI fails.
    return { messages: response.stdout, changedFiles, error: error.message, exitCode: response.exitCode };
  }
  return { messages: response.stdout, changedFiles, exitCode: response.exitCode };
}

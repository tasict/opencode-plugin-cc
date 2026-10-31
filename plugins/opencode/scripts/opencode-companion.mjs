#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, parseArgumentsInput } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, resolveOpencodeBinary, spawnDetached } from "./lib/process.mjs";
import { findRunningServer, createClient, connect } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, jobDataPath, jobLogPath } from "./lib/state.mjs";
import { resolveResultJob, resolveCancelableJob, enrichJob, matchJobReference } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import { renderResult, renderSetup, renderStatus, renderReview } from "./lib/render.mjs";
import { readJson } from "./lib/fs.mjs";
import { autoHealJobs } from "./lib/auto-heal.mjs";
import { ensureOpencodeConfig, readOpencodeConfig, missingPermissions } from "./lib/opencode-config.mjs";
import { stateRoot } from "./lib/state.mjs";
import { runCommand } from "./lib/process.mjs";
import { executeCliJob } from "./lib/execution.mjs";
import { incident } from "./lib/incidents.mjs";
import { killProcessTree } from "./lib/process.mjs";
import { discoverProviders } from "./lib/providers.mjs";
import { makeDigest } from "./lib/digest.mjs";
import { releaseWorktree } from "./lib/worktree.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const [subcommand, ...rawArgv] = process.argv.slice(2);
const argv = rawArgv.includes("--arguments-stdin")
  ? [...rawArgv.filter((x) => x !== "--arguments-stdin"), ...parseArgumentsInput(fs.readFileSync(0, "utf8"))]
  : rawArgv;

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  result: handleResult,
  "wait-and-result": handleWaitAndResult,
  cancel: handleCancel,
  heal: handleHeal,
  doctor: handleDoctor,
  config: handleConfig,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["full-access", "repair-config"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];
  let providerDiscovery = {};

  if (installed) {
    const server = await findRunningServer();
    serverRunning = !!server;

    if (server) {
      try {
        const client = createClient(server.url, {
          apiVersion: server.apiVersion,
          username: server.username,
          password: server.password,
          directory: await resolveWorkspace(),
        });
        const providerList = await client.listProviders();
        if (Array.isArray(providerList?.connected)) {
          // Current opencode API: GET /provider returns {all, default, connected}.
          providers = providerList.connected;
        } else if (Array.isArray(providerList)) {
          // Older opencode API: GET /provider returned a bare array of providers.
          providers = providerList.map((p) => p.id ?? p.name).filter(Boolean);
        }
      } catch {
        // Server may not be fully ready
      }
    }
  }

  if (installed && providers.length === 0) {
    providerDiscovery = await discoverProviders({ major: Number((version?.match(/(\d+)\./) ?? [])[1] || 1) });
    providers = providerDiscovery.providers;
  }

  // Handle review gate toggle
  const workspace = await resolveWorkspace();
  for (const [option, key] of [["full-access", "full_access"], ["repair-config", "repair_config"]]) {
    if (options[option] !== undefined) {
      if (!["true", "false"].includes(options[option])) throw new Error(`--${option} requires true or false`);
      updateState(workspace, (state) => { state.config ??= {}; state.config[key] = options[option] === "true"; });
    }
  }
  let reviewGate = false;

  if (options["enable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = true;
    });
    reviewGate = true;
  } else if (options["disable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = false;
    });
    reviewGate = false;
  } else {
    const state = loadState(workspace);
    reviewGate = state.config?.reviewGate ?? false;
  }

  const status = { installed, version, serverRunning, ...providerDiscovery, providers, reviewGate, userConfig: loadState(workspace).config };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderSetup(status));
  }
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

async function handleReview(argv) { return handleDelegatedJob("review", argv); }
async function handleAdversarialReview(argv) { return handleDelegatedJob("adversarial-review", argv); }
async function handleTask(argv) { return handleDelegatedJob("task", argv); }

async function handleDelegatedJob(type, argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["model", "agent", "base", "scope", "worktree", "incident-log", "prompt-file", "timeout-ms"],
    booleanOptions: ["write", "read-only", "background", "wait", "resume-last", "fresh", "full-access", "no-full-access", "no-repair-config", "standalone", "json", "text"],
  });
  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const taskText = options["prompt-file"] ? fs.readFileSync(options["prompt-file"], "utf8") : positional.join(" ");
  if (type === "task" && !taskText.trim()) throw new Error("No task text provided; use --prompt-file or --arguments-stdin");
  const fullAccess = !options["no-full-access"] && (options["full-access"] === true || state.config?.full_access === true);
  const incidentLog = options["incident-log"] ?? process.env.OPENCODE_INCIDENT_LOG;
  const isWrite = type === "task" && !options["read-only"];
  const lastTask = options["resume-last"] && !options.fresh
    ? state.jobs?.filter((j) => j.type === "task" && j.opencodeSessionId).at(-1) : null;
  const request = {
    type, taskText, fullAccess, isWrite, model: options.model,
    agent: options.agent ?? (fullAccess || isWrite ? "build" : "plan"),
    worktree: options.worktree, incidentLog,
    repairConfig: !options["no-repair-config"] && state.config?.repair_config !== false,
    standalone: !!options.standalone, base: options.base,
    resumeSessionId: lastTask?.opencodeSessionId,
    timeoutMs: options["timeout-ms"] ? Number(options["timeout-ms"]) : undefined,
  };
  if (options.worktree === "" || options.worktree === true) throw new Error("--worktree requires a branch name");
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 1)) throw new Error("--timeout-ms must be positive");
  const job = createJobRecord(workspace, type, { incidentLog, request, runtime: "cli" });
  if (options.background) {
    const logFile = jobLogPath(workspace, job.id);
    const requestFile = jobDataPath(workspace, job.id).replace(/\.json$/, ".request.json");
    fs.mkdirSync(path.dirname(requestFile), { recursive: true });
    fs.writeFileSync(requestFile, JSON.stringify(request), "utf8");
    upsertJob(workspace, { id: job.id, status: "queued", logFile, requestFile });
    try {
      const child = spawnDetached(process.execPath, [path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"), "task-worker", "--workspace", workspace, "--job-id", job.id], { cwd: workspace, logFile });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      upsertJob(workspace, { id: job.id, pid: child.pid });
      console.log(JSON.stringify({ jobId: job.id, status: "running", pid: child.pid, lastOutputAt: null, logPath: logFile }));
    } catch (err) {
      const failed = await runTrackedJob(workspace, job, async () => { throw err; });
      console.log(JSON.stringify(failed.digest)); process.exitCode = 1;
    }
    return;
  }
  const result = await runTrackedJob(workspace, job, (context) => executeCliJob(workspace, job, request, context, PLUGIN_ROOT));
  if (options.text && !options.json && type !== "task") {
    const review = tryParseJson(result.digest.reviewOutput ?? "");
    console.log(review && Array.isArray(review.findings) ? renderReview(review) : result.digest.reviewOutput || JSON.stringify(result.digest));
  } else console.log(JSON.stringify(result.digest));
  if (result.digest.status !== "passed") process.exitCode = 1;
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["workspace", "job-id"] });
  const workspace = options.workspace;
  const job = loadState(workspace).jobs?.find((j) => j.id === options["job-id"]);
  if (!job?.requestFile) throw new Error("Background request file missing");
  const request = JSON.parse(fs.readFileSync(job.requestFile, "utf8"));
  const result = await runTrackedJob(workspace, job, (context) => executeCliJob(workspace, job, request, context, PLUGIN_ROOT));
  console.log(JSON.stringify(result.digest));
  if (result.digest.status !== "passed") process.exitCode = 1;
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  // Heal first so "latest completed" reflects session reality, not a stale
  // "running" flag from a dead worker.
  const healable = (state.jobs ?? []).filter(
    (j) => j.type === "task" && j.runtime !== "cli" && j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length > 0) {
    await autoHealJobs(workspace, healable);
    state = loadState(workspace);
  }

  const lastTask = state.jobs
    ?.filter((j) => j.type === "task" && j.opencodeSessionId)
    ?.filter((j) => j.status === "completed" || j.status === "running")
    ?.filter((j) => !sessionId || j.sessionId === sessionId)
    ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

  const result = {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.available ? `Resumable session: ${result.opencodeSessionId}` : "No resumable session.");
  }
}

// ------------------------------------------------------------------
// Status / Result / Cancel
// ------------------------------------------------------------------

async function handleStatus(argv) {
  const { options, positional } = parseArgs(argv ?? [], {
    booleanOptions: ["json", "all", "text"],
  });

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  const printText = (jobs) => {
    const recent = [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    const finished = (job) => ["completed", "failed", "cancelled"].includes(job.status);
    console.log(renderStatus({ running: recent.filter((job) => !finished(job)), latestFinished: recent.find(finished) ?? null, recent }));
  };
  // A cheap, local-only query: never fetch session messages or print logs.
  if (positional[0]) {
    const { job, ambiguous } = matchJobReference(state.jobs ?? [], positional[0]);
    if (!job || ambiguous) {
      console.log(JSON.stringify({ job: null, error: ambiguous ? "ambiguous" : "not found" }));
      process.exitCode = 1; return;
    }
    const status = job.status === "completed" ? "done" : ["failed", "cancelled"].includes(job.status) ? "failed" : "running";
    if (options.text && !options.json) { printText([job]); return; }
    console.log(JSON.stringify({ job: { id: job.id, status, pid: job.pid ?? null, agentPid: job.agentPid ?? null, lastOutputAt: job.lastOutputAt ?? null } }));
    return;
  }
  const jobs = (state.jobs ?? []).filter((job) => options.all || !sessionId || job.sessionId === sessionId);
  if (options.text && !options.json) { printText(jobs); return; }
  console.log(JSON.stringify({ jobs: jobs.map((job) => ({
    id: job.id,
    status: job.status === "completed" ? "done" : ["failed", "cancelled"].includes(job.status) ? "failed" : "running",
    pid: job.pid ?? null, agentPid: job.agentPid ?? null, lastOutputAt: job.lastOutputAt ?? null,
  })) }));
}

async function handleResult(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  // Auto-heal before resolving so that if the caller asks for the latest
  // result, we don't return "no finished job" while a silently-completed
  // session is waiting to be reconciled.
  const healable = (state.jobs ?? []).filter(
    (j) => j.runtime !== "cli" && j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length > 0) {
    await autoHealJobs(workspace, healable);
    state = loadState(workspace);
  }

  const { job, ambiguous } = resolveResultJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No finished job found.");
    return;
  }

  const enriched = enrichJob(job, workspace);

  // Try to load detailed result data
  const dataFile = jobDataPath(workspace, job.id);
  const resultData = readJson(dataFile);

  console.log((resultData?.digest ?? enriched.digest) ? JSON.stringify(resultData?.digest ?? enriched.digest) : renderResult(enriched, resultData));
}

async function handleWaitAndResult(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["max-wait"],
    booleanOptions: ["json"],
  });

  const ref = positional[0];
  if (!ref) {
    console.error("No task ID provided.");
    process.exit(1);
  }

  const maxWait = parseInt(options["max-wait"] ?? "480", 10);
  if (isNaN(maxWait) || maxWait < 1 || maxWait > 600) {
    console.error("--max-wait must be between 1 and 600 seconds.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const jobs = state.jobs ?? [];

  const { job, ambiguous } = matchJobReference(jobs, ref);
  if (ambiguous) {
    console.error(`Ambiguous job reference "${ref}". Please provide a more specific ID.`);
    process.exit(1);
  }
  if (!job) {
    console.error(`No job found for "${ref}".`);
    process.exit(1);
  }

  const startTime = Date.now();
  const pollInterval = 250;
  const maxWaitMs = maxWait * 1000;
  const logFile = jobLogPath(workspace, job.id);

  const terminalStatuses = ["completed", "failed", "cancelled"];

  const isTerminal = (j) => terminalStatuses.includes(j?.status);

  if (isTerminal(job)) {
    const enriched = enrichJob(job, workspace);
    const dataFile = jobDataPath(workspace, job.id);
    const resultData = readJson(dataFile);
    console.log((resultData?.digest ?? enriched.digest) ? JSON.stringify(resultData?.digest ?? enriched.digest) : renderResult(enriched, resultData));
    process.exit(0);
  }

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const currentState = loadState(workspace);
    const { job: currentJob } = matchJobReference(currentState.jobs ?? [], ref);
    if (isTerminal(currentJob)) {
      const enriched = enrichJob(currentJob, workspace);
      const dataFile = jobDataPath(workspace, currentJob.id);
      const resultData = readJson(dataFile);
      console.log((resultData?.digest ?? enriched.digest) ? JSON.stringify(resultData?.digest ?? enriched.digest) : renderResult(enriched, resultData));
      process.exit(0);
    }
  }

  const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
  incident(job.incidentLog, "timeout", `wait-and-result ${job.id}`, `Wait exceeded ${maxWait}s`, "Job remains running; poll status later");
  const timeoutOutput = {
    status: "running",
    elapsed: elapsedSec,
    task_id: job.id,
    log_file: logFile,
  };

  if (options.json) {
    console.log(JSON.stringify(timeoutOutput));
  } else {
    console.log(JSON.stringify(timeoutOutput));
  }
  process.exit(2);
}

async function handleCancel(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);

  const { job, ambiguous } = resolveCancelableJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Multiple running jobs. Please specify a job ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No active job to cancel.");
    return;
  }

  // Abort the OpenCode session if we have one
  if (job.runtime !== "cli" && job.opencodeSessionId) {
    try {
      const client = await connect({ cwd: workspace });
      await client.abortSession(job.opencodeSessionId);
    } catch {
      // Server may not be running
    }
  }

  // Kill the process if we have a PID
  if (job.pid) {
    try {
      killProcessTree(job.pid, job.incidentLog);
    } catch (err) {
      incident(job.incidentLog, "command_failed", `cancel ${job.id}`, err.message, "Process may already have exited");
    }
  }

  const worktreeStatus = await releaseWorktree(workspace, job);

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Canceled by user",
    digest: makeDigest({ result: { error: "Canceled by user", exitCode: 130 }, logPath: jobLogPath(workspace, job.id), worktreePath: job.worktreePath, worktreeStatus, configChanges: job.configChanges }),
  });
  const cancelled = loadState(workspace).jobs.find((j) => j.id === job.id).digest;
  fs.writeFileSync(jobDataPath(workspace, job.id), JSON.stringify({ digest: cancelled }), "utf8");

  console.log(JSON.stringify(cancelled));
}

// ------------------------------------------------------------------
// Heal (batch auto-reconcile stuck jobs)
// ------------------------------------------------------------------

async function handleHeal(argv) {
  const { options } = parseArgs(argv ?? [], {
    booleanOptions: ["json", "dry-run", "all"],
  });

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  const dryRun = !!options["dry-run"];

  let jobs = state.jobs ?? [];
  if (!options.all && sessionId) {
    jobs = jobs.filter((j) => !j.sessionId || j.sessionId === sessionId);
  }

  const healable = jobs.filter(
    (j) => j.runtime !== "cli" && j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );

  const { actions } = await autoHealJobs(workspace, healable, { dryRun });

  if (options.json) {
    console.log(JSON.stringify({
      workspaceRoot: workspace,
      dryRun,
      scanned: healable.length,
      actions,
    }, null, 2));
    return;
  }

  console.log(`## Auto-Heal ${dryRun ? "(dry-run)" : ""}\n`);
  console.log(`- Workspace: ${workspace}`);
  console.log(`- Scanned stuck jobs: ${healable.length}`);
  if (actions.length === 0) {
    console.log(`- No actions needed.`);
    return;
  }
  console.log(`- Actions: ${actions.length}\n`);
  for (const a of actions) {
    const det = a.details ? ` — ${JSON.stringify(a.details)}` : "";
    console.log(`- **${a.id}**: ${a.action}${det}`);
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Extract text from an OpenCode API response.
 * @param {any} response
 * @returns {string}
 */
function extractResponseText(response) {
  if (typeof response === "string") return response;

  // Response shape: { info: { ... }, parts: [ { type: "text", text: "..." }, ... ] }
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  // Fallback: try info.content or just stringify
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  }

  return JSON.stringify(response, null, 2);
}

// ------------------------------------------------------------------
// Doctor (onboarding self-test + optional auto-repair)
// ------------------------------------------------------------------

async function handleDoctor(argv) {
  const { options } = parseArgs(argv ?? [], {
    booleanOptions: ["json", "fix", "verbose"],
  });
  const fix = !!options.fix;
  const wantJson = !!options.json;
  const verbose = !!options.verbose;
  const IS_WINDOWS = process.platform === "win32";

  const checks = [];
  const push = (name, status, detail, hint) => checks.push({ name, status, detail, hint });

  // 1. opencode binary in PATH
  const binary = await resolveOpencodeBinary();
  if (binary) {
    push("opencode-binary", "PASS", binary, null);
  } else {
    push("opencode-binary", "FAIL", "not in PATH",
      "Install: npm install -g @opencode/cli");
  }

  // 2. opencode version
  const ver = await runCommand("opencode", ["--version"]).catch(() => ({ exitCode: 1, stdout: "" }));
  if (ver.exitCode === 0) {
    push("opencode-version", "PASS", ver.stdout.trim() || "(unknown)", null);
  } else {
    push("opencode-version", "WARN", "could not resolve version", null);
  }

  const majorVersion = Number((ver.stdout.match(/v?(\d+)\./) ?? [])[1] || 0);

  // 3. OpenCode 1 needs headless permission repair. OpenCode 2 owns its
  // permission policy and managed service; do not overwrite user policy.
  const cfg = readOpencodeConfig();
  const missing = missingPermissions(cfg.data);
  if (majorVersion >= 2) {
    push("opencode-config", "PASS", `${cfg.path} (OpenCode 2 policy preserved)`, null);
  } else if (cfg.exists && missing.length === 0) {
    push("opencode-config", "PASS", `${cfg.path} (all permissions allow)`, null);
  } else {
    const detail = cfg.exists
      ? `${cfg.path} — missing: ${missing.join(", ")}`
      : `${cfg.path} — file missing`;
    if (fix) {
      const r = ensureOpencodeConfig({ silent: true });
      push("opencode-config", r.changed ? "PASS" : "WARN",
        r.changed ? `fixed: ${r.path}` : detail, null);
    } else {
      push("opencode-config", "FAIL", detail,
        "Run with --fix (or set: permission.{bash,edit,webfetch,external_directory} = \"allow\")");
    }
  }

  // 4. server reachable
  const server = await findRunningServer();
  if (server) {
    push("opencode-server", "PASS", `${server.url} (API v${server.apiVersion})`, null);
  } else {
    push("opencode-server", "WARN", "not reachable",
      majorVersion >= 2 ? "Start it: opencode service start, or task --standalone" : "Start it: opencode serve --port <configured-port>");
  }

  // 5. CLAUDE_PLUGIN_DATA sanity check
  const envData = process.env.CLAUDE_PLUGIN_DATA;
  if (envData && !/opencode/i.test(path.basename(envData))) {
    push("plugin-data-env", "WARN",
      `CLAUDE_PLUGIN_DATA=${envData} — basename lacks "opencode"`,
      "State will self-derive from script path; env is ignored to avoid cross-plugin leak.");
  } else {
    push("plugin-data-env", "PASS", envData ? envData : "(unset — self-derived)", null);
  }

  // 6. resolved state dir
  const workspace = await resolveWorkspace();
  const sRoot = stateRoot(workspace);
  push("state-dir", "PASS", sRoot, null);

  // 7. stuck jobs for this workspace
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  const jobs = (state.jobs ?? []).filter((j) => !sessionId || j.sessionId === sessionId);
  const healable = jobs.filter(
    (j) => j.runtime !== "cli" && j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length === 0) {
    push("stuck-jobs", "PASS", "none", null);
  } else if (fix) {
    const { actions } = await autoHealJobs(workspace, healable);
    push("stuck-jobs", "PASS", `healed ${actions.length}/${healable.length}`, null);
  } else {
    push("stuck-jobs", "WARN", `${healable.length} in non-terminal state`,
      "Run: companion heal  (or companion doctor --fix)");
  }

  // 8. disk free on state-dir parent
  if (IS_WINDOWS) {
    push("disk-free", "PASS", "N/A (Windows)", null);
  } else {
    // Walk up to the first existing ancestor — stateRoot may not exist yet.
    let probe = sRoot;
    while (probe && probe !== "/" && !fs.existsSync(probe)) probe = path.dirname(probe);
    const df = await runCommand("df", ["-h", probe]).catch(() => ({ exitCode: 1, stdout: "" }));
    const lines = (df.stdout || "").split("\n").filter(Boolean);
    const last = lines[lines.length - 1] || "";
    if (last && last !== lines[0]) {
      push("disk-free", "PASS", last.split(/\s+/).slice(0, 5).join(" "), null);
    } else {
      push("disk-free", "WARN", "df unavailable", null);
    }
  }

  // Summary
  const nFail = checks.filter((c) => c.status === "FAIL").length;
  const nWarn = checks.filter((c) => c.status === "WARN").length;
  const summary = nFail + nWarn === 0
    ? "All good"
    : `${nWarn} warnings, ${nFail} failures${!fix ? " — run with --fix to repair" : ""}`;

  if (wantJson) {
    console.log(JSON.stringify({
      summary: { failures: nFail, warnings: nWarn, fix },
      checks,
      workspace,
      stateRoot: sRoot,
    }, null, 2));
    return;
  }

  // Compact text output — ~1 line per check
  for (const c of checks) {
    const tag = c.status === "PASS" ? "PASS" : c.status === "WARN" ? "WARN" : "FAIL";
    console.log(`[${tag}] ${c.name} — ${c.detail}`);
    if (verbose && c.hint) console.log(`       ${c.hint}`);
    else if (c.status !== "PASS" && c.hint) console.log(`       ${c.hint}`);
  }
  console.log(`\n${nFail + nWarn === 0 ? "OK" : "!! "} ${summary}`);
  if (nFail > 0 && !fix) process.exit(1);
}

// ------------------------------------------------------------------
// Config (resolved settings dump — easier onboarding than reading source)
// ------------------------------------------------------------------

async function handleConfig(argv) {
  const { options } = parseArgs(argv ?? [], { booleanOptions: ["json"] });
  const wantJson = !!options.json;

  const envSpec = [
    ["OPENCODE_REQUEST_TIMEOUT_MS", "1800000", "Per-HTTP-request abort timeout"],
    ["OPENCODE_PROMPT_TIMEOUT_MS",  "14400000", "sendPrompt absolute cap (race against server 5min body-close)"],
    ["OPENCODE_IDLE_TIMEOUT_MS",    "900000", "Session idle watchdog (no activity → abort)"],
    ["OPENCODE_PGREP_MISS_THRESHOLD","3", "Consecutive pgrep-misses before declaring bash tool stuck"],
    ["OPENCODE_COMPLETION_POLL_MS", "5000", "Watcher poll interval during sendPrompt"],
    ["OPENCODE_MONITOR_RESULT_CHARS","(hook)", "Monitor hook: max chars per tool-result snippet"],
    ["OPENCODE_MONITOR_HEARTBEAT_POLLS","(hook)", "Monitor hook: polls between heartbeat pings"],
    ["OPENCODE_COMPANION_DATA",     "(self-derived)", "Override for plugin data dir"],
    ["OPENCODE_SERVER_PASSWORD",    "(unset)", "HTTP Basic auth password"],
    ["OPENCODE_SERVER_USERNAME",    "opencode", "HTTP Basic auth username"],
    ["OPENCODE_SERVER_URL",         "(auto)", "Explicit server URL override"],
  ];
  const envRows = envSpec.map(([name, dflt, desc]) => {
    const v = process.env[name];
    return {
      name,
      value: v != null ? v : dflt,
      source: v != null ? "env" : (dflt.startsWith("(") ? "default" : "default"),
      description: desc,
    };
  });

  const workspace = await resolveWorkspace();
  const sRoot = stateRoot(workspace);
  const cfg = readOpencodeConfig();
  const missing = missingPermissions(cfg.data);
  const server = await findRunningServer();
  const serverUrl = server?.url ?? "(not found)";
  const serverReachable = !!server;

  const out = {
    env: envRows,
    workspace,
    stateRoot: sRoot,
    opencodeConfig: {
      path: cfg.path,
      exists: cfg.exists,
      permissionsOk: missing.length === 0,
      missing,
    },
    server: {
      url: serverUrl,
      reachable: serverReachable,
      apiVersion: server?.apiVersion ?? null,
      version: server?.version ?? null,
      source: server?.source ?? null,
    },
  };

  if (wantJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log("## OpenCode Companion Config\n");
  console.log(`- Workspace: ${workspace}`);
  console.log(`- State dir: ${sRoot}`);
  console.log(`- Config file: ${cfg.path} (${cfg.exists ? "exists" : "missing"}${missing.length ? ", missing: " + missing.join(",") : ", permissions OK"})`);
  console.log(`- Server: ${serverUrl} (${serverReachable ? "reachable" : "unreachable"})`);
  console.log("\n### Environment variables\n");
  for (const r of envRows) {
    const src = r.source === "env" ? "env" : "default";
    console.log(`- ${r.name} = ${r.value} [${src}] — ${r.description}`);
  }
}

/**
 * Try to parse a string as JSON, returning null on failure.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  // Look for JSON in the text (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = jsonMatch ? jsonMatch[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

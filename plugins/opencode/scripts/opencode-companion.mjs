#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, ensureServer, createClient, connect } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, generateJobId, jobDataPath, jobLogPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJob, enrichJob, matchJobReference } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup } from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { getDiff, getStatus as getGitStatus } from "./lib/git.mjs";
import { readJson } from "./lib/fs.mjs";
import { autoHealJob, autoHealJobs, getSessionLastActivity } from "./lib/auto-heal.mjs";
import { ensureOpencodeConfig, readOpencodeConfig, missingPermissions, resolveConfigPath } from "./lib/opencode-config.mjs";
import { stateRoot } from "./lib/state.mjs";
import { runCommand } from "./lib/process.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  result: handleResult,
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
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  let serverRunning = false;
  let providers = [];

  if (installed) {
    serverRunning = await isServerRunning();

    if (serverRunning) {
      try {
        const client = createClient("http://127.0.0.1:4096");
        const providerList = await client.listProviders();
        if (Array.isArray(providerList)) {
          providers = providerList.map((p) => p.id ?? p.name).filter(Boolean);
        }
      } catch {
        // Server may not be fully ready
      }
    }
  }

  // Handle review gate toggle
  const workspace = await resolveWorkspace();
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

  const status = { installed, version, serverRunning, providers, reviewGate };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderSetup(status));
  }
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

async function handleReview(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "review", { base: options.base });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating review session...");
      const session = await client.createSession({ title: `Code Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: false,
      }, PLUGIN_ROOT);

      report("reviewing", "Running review...");
      log(`Prompt length: ${prompt.length} chars`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: "plan", // read-only agent for reviews
      });

      report("finalizing", "Processing review output...");

      // Try to parse structured output
      const text = extractResponseText(response);
      let structured = tryParseJson(text);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Review failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleAdversarialReview(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const focus = positional.join(" ").trim();
  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "adversarial-review", {
    base: options.base,
    focus,
  });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating adversarial review session...");
      const session = await client.createSession({ title: `Adversarial Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: true,
        focus,
      }, PLUGIN_ROOT);

      report("reviewing", "Running adversarial review...");
      log(`Prompt length: ${prompt.length} chars, focus: ${focus || "(none)"}`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: "plan",
      });

      report("finalizing", "Processing review output...");

      const text = extractResponseText(response);
      let structured = tryParseJson(text);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Adversarial review failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["model", "agent"],
    booleanOptions: ["write", "background", "wait", "resume-last", "fresh"],
  });

  const taskText = extractTaskText(argv, ["model", "agent"], [
    "write", "background", "wait", "resume-last", "fresh",
  ]);

  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const isWrite = options.write !== undefined ? options.write : true;
  const agentName = options.agent ?? (isWrite ? "build" : "plan");

  // Check for resume
  let resumeSessionId = null;
  if (options["resume-last"]) {
    const state = loadState(workspace);
    const sessionId = getClaudeSessionId();
    const lastTask = state.jobs
      ?.filter((j) => j.type === "task" && j.opencodeSessionId)
      ?.filter((j) => !sessionId || j.sessionId === sessionId)
      ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

    if (lastTask?.opencodeSessionId) {
      resumeSessionId = lastTask.opencodeSessionId;
    }
  }

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
  });

  // Background mode: spawn a detached worker
  if (options.background) {
    const logFile = jobLogPath(workspace, job.id);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    upsertJob(workspace, {
      id: job.id,
      status: "queued",
      phase: "queued",
      logFile,
      request: {
        taskText,
        agentName,
        isWrite,
        resumeSessionId,
        model: options.model,
      },
    });

    const workerArgs = [
      path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
      "task-worker",
      "--job-id", job.id,
      "--workspace", workspace,
      "--task-text", taskText,
      "--agent", agentName,
    ];
    if (isWrite) workerArgs.push("--write");
    if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
    if (options.model) workerArgs.push("--model", options.model);

    const child = spawnDetached("node", workerArgs, { cwd: workspace, logFile });
    upsertJob(workspace, { id: job.id, pid: child.pid });
    console.log(`OpenCode task started in background: ${job.id}`);
    console.log("Check `/opencode:status` for progress.");
    return;
  }

  // Foreground mode
  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        report("starting", `Resuming OpenCode session ${resumeSessionId}...`);
        sessionId = resumeSessionId;
      } else {
        report("starting", "Creating new OpenCode session...");
        const session = await client.createSession({ title: `Task ${job.id}` });
        sessionId = session.id;
      }
      upsertJob(workspace, { id: job.id, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });

      report("investigating", "Sending task to OpenCode...");
      log(`Agent: ${agentName}, Write: ${isWrite}, Prompt: ${prompt.length} chars`);

      const response = await client.sendPrompt(sessionId, prompt, {
        agent: agentName,
      });

      report("finalizing", "Processing task output...");

      const text = extractResponseText(response);

      // Get changed files if write mode
      let changedFiles = [];
      if (isWrite) {
        try {
          const diff = await client.getSessionDiff(sessionId);
          if (diff?.files) {
            changedFiles = diff.files.map((f) => f.path || f.name).filter(Boolean);
          }
        } catch {
          // diff endpoint may not be available
        }
      }

      return {
        rendered: text,
        messages: response,
        changedFiles,
        summary: text.slice(0, 500),
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-text", "agent", "model", "resume-session"],
    booleanOptions: ["write"],
  });

  const workspace = options.workspace;
  const jobId = options["job-id"];
  const taskText = options["task-text"];
  const agentName = options.agent ?? "build";
  const isWrite = !!options.write;
  const resumeSessionId = options["resume-session"];

  if (!workspace || !jobId || !taskText) {
    process.exit(1);
  }

  try {
    await runTrackedJob(workspace, { id: jobId }, async ({ report, log }) => {
      report("starting", "Background worker connecting to OpenCode...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        sessionId = resumeSessionId;
        report("starting", `Resuming session ${resumeSessionId}...`);
      } else {
        const session = await client.createSession({ title: `Task ${jobId}` });
        sessionId = session.id;
        report("starting", `Created session ${sessionId}`);
      }
      upsertJob(workspace, { id: jobId, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });
      report("investigating", "Running task...");

      const response = await client.sendPrompt(sessionId, prompt, {
        agent: agentName,
      });

      const text = extractResponseText(response);
      report("finalizing", "Done");

      return { rendered: text, summary: text.slice(0, 500) };
    });
  } catch (err) {
    // Error is already logged by runTrackedJob
    process.exit(1);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  // Heal first so "latest completed" reflects session reality, not a stale
  // "running" flag from a dead worker.
  const healable = (state.jobs ?? []).filter(
    (j) => j.type === "task" && j.opencodeSessionId &&
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
    booleanOptions: ["json", "all"],
  });

  const workspace = await resolveWorkspace();
  let state = loadState(workspace);
  const sessionId = getClaudeSessionId();
  // Auto-heal stuck jobs before building the snapshot so `status` never lies
  // about completion. Safe on ECONNREFUSED (probe returns reachable:false).
  const healable = (state.jobs ?? []).filter(
    (j) => j.opencodeSessionId &&
      ["starting", "investigating", "running", "finalizing"].includes(j.status),
  );
  if (healable.length > 0) {
    await autoHealJobs(workspace, healable);
    state = loadState(workspace);
  }
  const jobs = state.jobs ?? [];
  const wantJson = !!options.json;
  // --all widens the snapshot filter to every session's jobs; without --all we
  // still filter to the current Claude session for the existing markdown UX.
  const sessionFilter = options.all ? undefined : sessionId;
  const ref = positional?.[0];

  // Single-task query — `status <tid> [--json]`.
  if (ref) {
    const { job, ambiguous } = matchJobReference(jobs, ref);
    if (ambiguous) {
      if (wantJson) {
        console.log(JSON.stringify({ workspaceRoot: workspace, job: null, error: "ambiguous" }));
      } else {
        console.error(`Ambiguous job reference "${ref}". Please provide a more specific ID prefix.`);
      }
      process.exit(ambiguous ? 2 : 0);
      return;
    }
    if (wantJson) {
      const enriched = job ? enrichJob(job, workspace) : null;
      console.log(JSON.stringify({ workspaceRoot: workspace, job: enriched }));
      return;
    }
    if (!job) {
      console.log(`No job found for "${ref}" in workspace ${workspace}.`);
      return;
    }
    console.log(renderStatus({ running: [], latestFinished: null, recent: [enrichJob(job, workspace)] }));
    return;
  }

  const snapshot = buildStatusSnapshot(jobs, workspace, { sessionId: sessionFilter });

  // Enrich running jobs with a live breadcrumb from the opencode session —
  // gives newcomers a human-legible "running — bash: docker exec ..." line
  // instead of a stale "investigating" phase from state.json. Runs in parallel
  // and gracefully falls back if the server is unreachable.
  if (snapshot.running.length > 0) {
    const baseUrl = "http://127.0.0.1:4096";
    await Promise.all(snapshot.running.map(async (job) => {
      if (!job.opencodeSessionId) return;
      const act = await getSessionLastActivity(baseUrl, job.opencodeSessionId);
      if (!act) return;
      const age = act.ageSec != null ? `${act.ageSec}s ago` : "";
      if (act.kind === "tool") {
        const head = act.command ? `: ${act.command}` : "";
        job.breadcrumb = `running — ${act.tool}${head}${age ? ` (${age})` : ""}`.trim();
      } else if (act.kind === "text") {
        job.breadcrumb = `running — "${act.text}"${age ? ` (${age})` : ""}`;
      }
    }));
  }

  if (wantJson) {
    // Machine-readable shape mirrors the single-task case so callers can treat
    // both uniformly: a `.job` field is present for single-task, otherwise
    // `.running`/`.recent` arrays describe the whole workspace snapshot.
    console.log(JSON.stringify({
      workspaceRoot: workspace,
      running: snapshot.running,
      latestFinished: snapshot.latestFinished,
      recent: snapshot.recent,
    }));
    return;
  }

  console.log(renderStatus(snapshot));
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
    (j) => j.opencodeSessionId &&
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

  console.log(renderResult(enriched, resultData));
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
  if (job.opencodeSessionId) {
    try {
      const client = createClient("http://127.0.0.1:4096");
      await client.abortSession(job.opencodeSessionId);
    } catch {
      // Server may not be running
    }
  }

  // Kill the process if we have a PID
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Canceled by user",
  });

  console.log(`Canceled job: ${job.id}`);
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
    (j) => j.opencodeSessionId &&
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
  const which = await runCommand("which", ["opencode"]).catch(() => ({ exitCode: 1, stdout: "" }));
  if (which.exitCode === 0 && which.stdout.trim()) {
    push("opencode-binary", "PASS", which.stdout.trim(), null);
  } else {
    push("opencode-binary", "FAIL", "not in PATH",
      "Install: npm i -g opencode-ai  OR  brew install opencode");
  }

  // 2. opencode version
  const ver = await runCommand("opencode", ["--version"]).catch(() => ({ exitCode: 1, stdout: "" }));
  if (ver.exitCode === 0) {
    push("opencode-version", "PASS", ver.stdout.trim() || "(unknown)", null);
  } else {
    push("opencode-version", "WARN", "could not resolve version", null);
  }

  // 3. opencode.json permissions (HEADLESS-SAFE — biggest footgun)
  const cfg = readOpencodeConfig();
  const missing = missingPermissions(cfg.data);
  if (cfg.exists && missing.length === 0) {
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
  const serverUrl = "http://127.0.0.1:4096";
  let reachable = false;
  try {
    const r = await fetch(`${serverUrl}/global/health`, { signal: AbortSignal.timeout(2000) });
    reachable = r.ok;
  } catch {
    reachable = false;
  }
  if (reachable) {
    push("opencode-server", "PASS", `${serverUrl} reachable`, null);
  } else {
    push("opencode-server", "WARN", `${serverUrl} not reachable`,
      "Start it: opencode serve --port 4096 &");
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
    (j) => j.opencodeSessionId &&
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
  const serverUrl = "http://127.0.0.1:4096";
  let serverReachable = false;
  try {
    const r = await fetch(`${serverUrl}/global/health`, { signal: AbortSignal.timeout(2000) });
    serverReachable = r.ok;
  } catch {}

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
    server: { url: serverUrl, reachable: serverReachable },
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

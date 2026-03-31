// Job lifecycle tracking and progress reporting for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendLine } from "./fs.mjs";
import { generateJobId, upsertJob, jobLogPath, jobDataPath } from "./state.mjs";

const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";

/**
 * Get the current Claude session ID from environment.
 * @returns {string|undefined}
 */
export function getClaudeSessionId() {
  return process.env[SESSION_ID_ENV] || process.env.CLAUDE_SESSION_ID;
}

/**
 * Create a new job record.
 * @param {string} workspacePath
 * @param {string} type - "review" | "adversarial-review" | "task"
 * @param {object} [meta] - additional metadata
 * @returns {object} the created job
 */
export function createJobRecord(workspacePath, type, meta = {}) {
  const id = generateJobId(type);
  const sessionId = getClaudeSessionId();
  const job = {
    id,
    type,
    status: "pending",
    sessionId,
    ...meta,
  };
  upsertJob(workspacePath, job);
  return job;
}

/**
 * Run a tracked job with full lifecycle management.
 * @param {string} workspacePath
 * @param {object} job
 * @param {(ctx: { report: Function, log: Function }) => Promise<object>} runner
 * @returns {Promise<object>} the job result
 */
export async function runTrackedJob(workspacePath, job, runner) {
  // Mark as running
  upsertJob(workspacePath, { id: job.id, status: "running", pid: process.pid });

  const logFile = jobLogPath(workspacePath, job.id);
  ensureDir(path.dirname(logFile));

  const report = (phase, message) => {
    const line = `[${new Date().toISOString()}] [${phase}] ${message}`;
    appendLine(logFile, line);
    process.stderr.write(line + "\n");
    upsertJob(workspacePath, { id: job.id, phase });
  };

  const log = (message) => {
    appendLine(logFile, `[${new Date().toISOString()}] ${message}`);
  };

  try {
    report("starting", `Job ${job.id} started`);
    const result = await runner({ report, log });

    // Mark as completed
    upsertJob(workspacePath, {
      id: job.id,
      status: "completed",
      completedAt: new Date().toISOString(),
      result: result?.rendered ?? result?.summary ?? null,
    });

    // Write result data file
    const dataFile = jobDataPath(workspacePath, job.id);
    ensureDir(path.dirname(dataFile));
    fs.writeFileSync(dataFile, JSON.stringify(result, null, 2), "utf8");

    report("completed", `Job ${job.id} completed`);
    return result;
  } catch (err) {
    upsertJob(workspacePath, {
      id: job.id,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: err.message,
    });
    report("failed", `Job ${job.id} failed: ${err.message}`);
    throw err;
  }
}

/**
 * Create a progress reporter for a job.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {{ report: Function, log: Function }}
 */
export function createProgressReporter(workspacePath, jobId) {
  const logFile = jobLogPath(workspacePath, jobId);

  return {
    report(phase, message) {
      const line = `[${new Date().toISOString()}] [${phase}] ${message}`;
      appendLine(logFile, line);
      upsertJob(workspacePath, { id: jobId, phase });
    },
    log(message) {
      appendLine(logFile, `[${new Date().toISOString()}] ${message}`);
    },
  };
}

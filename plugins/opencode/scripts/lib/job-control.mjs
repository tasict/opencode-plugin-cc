// Job control: query, sort, enrich, and build status snapshots.

import { tailLines } from "./fs.mjs";
import { jobLogPath } from "./state.mjs";

/**
 * Sort jobs newest first by updatedAt.
 * @param {object[]} jobs
 * @returns {object[]}
 */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Enrich a job with computed fields: elapsed time, progress preview, phase.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {object}
 */
export function enrichJob(job, workspacePath) {
  const enriched = { ...job };

  // Elapsed time
  if (job.createdAt) {
    const start = new Date(job.createdAt).getTime();
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    enriched.elapsedMs = end - start;
    enriched.elapsed = formatDuration(enriched.elapsedMs);
  }

  // Progress preview from log tail
  if (job.status === "running") {
    const logFile = jobLogPath(workspacePath, job.id);
    const lines = tailLines(logFile, 3);
    if (lines.length > 0) {
      enriched.progressPreview = lines.join("\n");
    }
  }

  // Infer phase from log
  if (job.status === "running" && !job.phase) {
    enriched.phase = inferPhase(job, workspacePath);
  }

  return enriched;
}

/**
 * Infer the current phase of a running job from its log.
 * @param {object} job
 * @param {string} workspacePath
 * @returns {string}
 */
function inferPhase(job, workspacePath) {
  const logFile = jobLogPath(workspacePath, job.id);
  const lines = tailLines(logFile, 20);
  const text = lines.join("\n").toLowerCase();

  if (text.includes("error") || text.includes("failed")) return "failed";
  if (text.includes("finalizing") || text.includes("complete")) return "finalizing";
  if (text.includes("editing") || text.includes("writing")) return "editing";
  if (text.includes("verifying") || text.includes("testing")) return "verifying";
  if (text.includes("investigating") || text.includes("analyzing")) return "investigating";
  if (text.includes("reviewing")) return "reviewing";
  if (text.includes("starting") || text.includes("initializing")) return "starting";
  return "running";
}

/**
 * Build a status snapshot for display.
 * @param {object[]} jobs
 * @param {string} workspacePath
 * @param {{ sessionId?: string }} opts
 * @returns {{ running: object[], latestFinished: object|null, recent: object[] }}
 */
export function buildStatusSnapshot(jobs, workspacePath, opts = {}) {
  let filtered = jobs;
  if (opts.sessionId) {
    filtered = jobs.filter((j) => j.sessionId === opts.sessionId);
  }

  const sorted = sortJobsNewestFirst(filtered);
  const enriched = sorted.map((j) => enrichJob(j, workspacePath));

  const running = enriched.filter((j) => j.status === "running");
  const finished = enriched.filter((j) => j.status !== "running");
  const latestFinished = finished[0] ?? null;
  const recent = finished.slice(0, 5);

  return { running, latestFinished, recent };
}

/**
 * Find a single job by ID or prefix match.
 * @param {object[]} jobs
 * @param {string} ref
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function matchJobReference(jobs, ref) {
  if (!ref) return { job: null, ambiguous: false };

  // Exact match first
  const exact = jobs.find((j) => j.id === ref);
  if (exact) return { job: exact, ambiguous: false };

  // Prefix match
  const matches = jobs.filter((j) => j.id.startsWith(ref));
  if (matches.length === 1) return { job: matches[0], ambiguous: false };
  if (matches.length > 1) return { job: null, ambiguous: true };

  return { job: null, ambiguous: false };
}

/**
 * Resolve a job that has finished (completed or failed).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveResultJob(jobs, ref) {
  const finished = jobs.filter((j) => j.status === "completed" || j.status === "failed");
  if (!ref) {
    const sorted = sortJobsNewestFirst(finished);
    return { job: sorted[0] ?? null, ambiguous: false };
  }
  return matchJobReference(finished, ref);
}

/**
 * Resolve a job that can be canceled (running).
 * @param {object[]} jobs
 * @param {string} [ref]
 * @returns {{ job: object|null, ambiguous: boolean }}
 */
export function resolveCancelableJob(jobs, ref) {
  const running = jobs.filter((j) => j.status === "running");
  if (!ref) {
    return { job: running[0] ?? null, ambiguous: running.length > 1 };
  }
  return matchJobReference(running, ref);
}

/**
 * Format a duration in milliseconds to human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

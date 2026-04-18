// File-system-based persistent state for the OpenCode companion.
// Mirrors the codex-plugin-cc state.mjs pattern: SHA-256 hash of workspace path,
// JSON state file, per-job files and logs.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readJson, writeJson } from "./fs.mjs";

const MAX_JOBS = 50;

/**
 * Derive the opencode-companion's own plugin data directory from the script's
 * install path. Claude Code installs plugins at
 *   <root>/plugins/cache/<owner>-<repo>/<plugin>/<version>/scripts/lib/state.mjs
 * and assigns per-plugin data at
 *   <root>/plugins/data/<plugin>-<owner>-<repo>/
 * If CLAUDE_PLUGIN_DATA is exported by an UNRELATED plugin (e.g. codex
 * companion), env-based lookup would leak opencode state into that plugin's
 * data dir. Deriving our own path avoids that cross-contamination.
 *
 * Returns null if the path layout doesn't match (e.g. running from repo source).
 */
function deriveOwnDataDir() {
  try {
    const here = fileURLToPath(import.meta.url);
    const parts = here.split(path.sep);
    const cacheIdx = parts.lastIndexOf("cache");
    if (cacheIdx < 1 || cacheIdx + 4 >= parts.length) return null;
    const ownerRepo = parts[cacheIdx + 1];
    const pluginName = parts[cacheIdx + 2];
    const rootBase = parts.slice(0, cacheIdx).join(path.sep);
    return path.join(rootBase, "data", `${pluginName}-${ownerRepo}`);
  } catch {
    return null;
  }
}

/**
 * Compute the state directory root for a workspace.
 *
 * Priority:
 *   1. Explicit opt-in via OPENCODE_COMPANION_DATA (per-plugin override)
 *   2. Self-derived path from script location (correct under normal install)
 *   3. Only trust CLAUDE_PLUGIN_DATA when it already names our own plugin —
 *      otherwise ignore it (another plugin may have exported it into our env)
 *   4. Fallback: /tmp/opencode-companion
 *
 * @param {string} workspacePath
 * @returns {string}
 */
export function stateRoot(workspacePath) {
  let base;
  if (process.env.OPENCODE_COMPANION_DATA) {
    base = path.join(process.env.OPENCODE_COMPANION_DATA, "state");
  } else {
    const own = deriveOwnDataDir();
    const envData = process.env.CLAUDE_PLUGIN_DATA;
    if (own) {
      base = path.join(own, "state");
    } else if (envData && /opencode/i.test(path.basename(envData))) {
      base = path.join(envData, "state");
    } else {
      base = path.join("/tmp", "opencode-companion");
    }
  }
  const hash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return path.join(base, hash);
}

/**
 * Path to the main state.json file.
 * @param {string} root
 * @returns {string}
 */
function stateFile(root) {
  return path.join(root, "state.json");
}

/**
 * Load the state for a workspace.
 * @param {string} workspacePath
 * @returns {{ config: object, jobs: object[] }}
 */
export function loadState(workspacePath) {
  const root = stateRoot(workspacePath);
  const data = readJson(stateFile(root));
  return data ?? { config: {}, jobs: [] };
}

/**
 * Save the state for a workspace.
 * @param {string} workspacePath
 * @param {object} state
 */
export function saveState(workspacePath, state) {
  const root = stateRoot(workspacePath);
  writeJson(stateFile(root), state);
}

/**
 * Update the state atomically using a mutator function.
 * @param {string} workspacePath
 * @param {(state: object) => void} mutator
 * @returns {object} the updated state
 */
export function updateState(workspacePath, mutator) {
  const state = loadState(workspacePath);
  mutator(state);
  saveState(workspacePath, state);
  return state;
}

/**
 * Generate a unique job ID.
 * @param {string} prefix - e.g. "review", "task"
 * @returns {string}
 */
export function generateJobId(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Insert or update a job in the state.
 * @param {string} workspacePath
 * @param {object} job
 */
export function upsertJob(workspacePath, job) {
  updateState(workspacePath, (state) => {
    if (!state.jobs) state.jobs = [];
    const idx = state.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      state.jobs[idx] = { ...state.jobs[idx], ...job, updatedAt: new Date().toISOString() };
    } else {
      state.jobs.push({ ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    // Prune old jobs beyond MAX_JOBS
    if (state.jobs.length > MAX_JOBS) {
      state.jobs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      state.jobs = state.jobs.slice(0, MAX_JOBS);
    }
  });
}

/**
 * Get the path for a job's log file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobLogPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.log`);
}

/**
 * Get the path for a job's data file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobDataPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.json`);
}

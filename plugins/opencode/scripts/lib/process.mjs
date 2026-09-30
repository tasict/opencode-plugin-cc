// Process utilities for the OpenCode companion.

import { spawn } from "node:child_process";
import fs from "node:fs";

const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  return new Promise((resolve) => {
    // `which` isn't a native Windows binary; `where` is the equivalent.
    const proc = spawn(IS_WINDOWS ? "where" : "which", ["opencode"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : null));
    proc.on("error", () => resolve(null));
  });
}

/**
 * Check if `opencode` CLI is available.
 * @returns {Promise<boolean>}
 */
export async function isOpencodeInstalled() {
  const bin = await resolveOpencodeBinary();
  return bin !== null;
}

/**
 * Get the installed opencode version.
 * @returns {Promise<string|null>}
 */
export async function getOpencodeVersion() {
  return new Promise((resolve) => {
    // Windows npm shims are .cmd/.ps1; spawn() only resolves those via a shell.
    const proc = spawn("opencode", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: IS_WINDOWS,
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    proc.on("error", () => resolve(null));
  });
}

/**
 * Run a command and return { stdout, stderr, exitCode }.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: IS_WINDOWS,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: String(err), exitCode: 1 }));
  });
}

/**
 * Spawn a detached background process.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnDetached(cmd, args, opts = {}) {
  const logFd = opts.logFile ? fs.openSync(opts.logFile, "a") : null;
  let child;
  try {
    child = spawn(cmd, args, {
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      detached: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      // No shell: args must reach the child as-is. A Windows shell would
      // split the task text (e.g. --task-text "Reply with exactly: X") into
      // separate argv tokens, truncating the task to its first word.
      shell: false,
    });
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
  child.unref();
  return child;
}

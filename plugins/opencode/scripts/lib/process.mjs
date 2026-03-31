// Process utilities for the OpenCode companion.

import { spawn } from "node:child_process";

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  return new Promise((resolve) => {
    const proc = spawn("which", ["opencode"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
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
    const proc = spawn("opencode", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve(code === 0 ? out.trim() : null));
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
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
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
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  child.unref();
  return child;
}

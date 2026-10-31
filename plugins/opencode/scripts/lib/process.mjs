// Process utilities for the OpenCode companion.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { incident, failureType } from "./incidents.mjs";

export const commandContext = new AsyncLocalStorage();

export function killProcessTree(pid, incidentLog, reason = "Cancelled by user") {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Invalid child PID");
  incident(incidentLog, "killed_process", `terminate process tree ${pid}`, reason, "Terminating owned job processes");
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "taskkill failed");
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
  }
}

const IS_WINDOWS = process.platform === "win32";

// Never execute npm shims with cmd.exe: cmd expands %, &, | and quotes.
// Resolve only recognized npm launcher targets; reject arbitrary batch files.
export function resolveInvocation(cmd, args = [], opts = {}) {
  if (!IS_WINDOWS) return { command: cmd, args };
  let executable = cmd;
  if (!path.isAbsolute(cmd)) {
    const env = opts.env ?? process.env;
    const searchPath = env.PATH ?? env.Path ?? "";
    const names = path.extname(cmd) ? [cmd] : [cmd + ".exe", cmd + ".com", cmd + ".cmd", cmd + ".bat"];
    const candidates = searchPath.split(path.delimiter).flatMap((directory) => names.map((name) => path.join(directory.replace(/^"|"$/g, ""), name)));
    executable = candidates.find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } }) ?? cmd;
  }
  if (/\.(cmd|bat)$/i.test(executable)) {
    const source = fs.readFileSync(executable, "utf8");
    // npm's IF EXIST/SET lines mention node.exe before the actual command.
    // Only accept a launcher invocation forwarding argv, never a guard.
    const target = source.split(/\r?\n/).reverse()
      .filter((line) => !/^\s*@?(?:if|set|rem)\b/i.test(line) && /%\*/.test(line))
      .map((line) => line.match(/"(?:%dp0%|%~dp0)[\\/]([^"\r\n]+\.(?:exe|[cm]?js))"/i))
      .find(Boolean);
    if (!target) throw new Error(`Unsupported Windows launcher: ${executable}; configure a native executable`);
    const file = path.resolve(path.dirname(executable), target[1]);
    if (!fs.existsSync(file)) throw new Error(`Windows launcher target missing: ${file}`);
    return /\.exe$/i.test(file) ? { command: file, args } : { command: process.execPath, args: [file, ...args] };
  }
  return { command: executable, args };
}

export function spawnCommand(cmd, args, opts = {}) {
  const env = { ...process.env, ...opts.env, PWD: opts.cwd ?? process.cwd() };
  const invocation = resolveInvocation(cmd, args, { env });
  return spawn(invocation.command, invocation.args, { ...opts, env, shell: false, windowsHide: true });
}

export function runCommandSync(cmd, args, opts = {}) {
  const invocation = resolveInvocation(cmd, args, opts);
  return spawnSync(invocation.command, invocation.args, { ...opts, shell: false, windowsHide: true });
}

/**
 * Resolve the full path to the `opencode` binary.
 * @returns {Promise<string|null>}
 */
export async function resolveOpencodeBinary() {
  if (IS_WINDOWS) {
    try {
      const { command } = resolveInvocation("opencode");
      return fs.existsSync(command) ? command : null;
    } catch { return null; }
  }
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
    const proc = spawnCommand("opencode", ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
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
    const context = commandContext.getStore();
    let timer, settled = false, timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (timedOut) { result.exitCode = 124; result.stderr += "\nCommand timed out"; }
      context?.commands?.push({ command: [cmd, ...args].join(" "), exitCode: result.exitCode });
      context?.log?.(`$ ${[cmd, ...args].join(" ")}\n${result.stdout}${result.stderr}`);
      if (result.exitCode !== 0) {
        const error = result.stderr || result.stdout;
        incident(opts.incidentLog ?? context?.incidentLog, failureType(error), [cmd, ...args].join(" "), error, "Command returned a nonzero exit code; inspect digest");
        context?.recordedFailures?.push(error);
      }
      resolve(result);
    };
    let proc;
    try { proc = spawnCommand(cmd, args, {
      stdio: [opts.input == null ? "ignore" : "pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: !IS_WINDOWS,
    }); } catch (err) { finish({ stdout: "", stderr: String(err), exitCode: 1 }); return; }
    if (opts.timeoutMs) timer = setTimeout(() => {
      timedOut = true;
      try { killProcessTree(proc.pid, opts.incidentLog ?? context?.incidentLog, `Command timed out after ${opts.timeoutMs}ms`); }
      catch (err) { context?.log?.(err.message); }
    }, opts.timeoutMs);
    opts.onSpawn?.(proc);
    if (opts.input != null) { proc.stdin.on("error", () => {}); proc.stdin.end(opts.input); }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdout.on("data", (d) => opts.onOutput?.(d.toString(), "stdout"));
    proc.stderr.on("data", (d) => opts.onOutput?.(d.toString(), "stderr"));
    proc.on("close", (exitCode) => finish({ stdout, stderr, exitCode: exitCode ?? 1 }));
    proc.on("error", (err) => finish({ stdout: "", stderr: String(err), exitCode: 1 }));
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
    child = spawnCommand(cmd, args, {
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      detached: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
  } finally {
    if (logFd !== null) fs.closeSync(logFd);
  }
  child.unref();
  return child;
}

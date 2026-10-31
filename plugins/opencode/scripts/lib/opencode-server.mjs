// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readOpencodeConfig } from "./opencode-config.mjs";
import { classifyError } from "./errors.mjs";
import { spawnCommand, runCommandSync } from "./process.mjs";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_PORT = 0;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Long-running tasks (e.g. engine builds, large refactors) can easily exceed
// the old 5-10 min caps, causing `fetch failed` at a fixed deadline. Default
// PROMPT_TIMEOUT_MS to 4 hours — absolute safety cap. Real stall detection
// lives in the watcher via IDLE_TIMEOUT_MS + pgrep child-process check.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 1_800_000;
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS) || 14_400_000;
const STRICT_TERMINAL = process.env.OPENCODE_STRICT_TERMINAL === "1";
// How long a session may go without ANY activity signal before we assume it
// is stuck. Activity = new message, new parts, tool output growth, status
// change. Default 1h — long enough for silent-but-live tool subprocesses.
const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 3_600_000;
// Bash-tool "no child process" consecutive-miss threshold. If the latest
// tool is a bash in status=running but opencode serve has zero child
// processes for N polls in a row, declare stuck. 3 × 5s = 15s grace.
const PGREP_MISS_THRESHOLD = Number(process.env.OPENCODE_PGREP_MISS_THRESHOLD) || 3;

function basicAuthHeader(username, password) {
  if (!password) return null;
  const cred = Buffer.from(`${username || "opencode"}:${password}`).toString("base64");
  return `Basic ${cred}`;
}

/**
 * OpenCode 2 writes its managed-service registration here on every platform.
 * XDG_STATE_HOME remains authoritative when explicitly configured.
 */
export function serviceRegistrationPaths(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const paths = [];
  if (env.XDG_STATE_HOME) {
    paths.push(path.join(env.XDG_STATE_HOME, "opencode", "service.json"));
  }
  paths.push(path.join(home, ".local", "state", "opencode", "service.json"));
  return [...new Set(paths)];
}

export function readServiceRegistration(paths = serviceRegistrationPaths()) {
  for (const registrationPath of paths) {
    try {
      const data = JSON.parse(fs.readFileSync(registrationPath, "utf8"));
      if (typeof data?.url !== "string" || !data.url.startsWith("http")) continue;
      return { ...data, registrationPath };
    } catch {
      // Missing, stale, or mid-write registration. Try the next candidate.
    }
  }
  return null;
}

async function probeJson(url, requestPath, headers = {}) {
  try {
    const res = await fetch(`${url}${requestPath}`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("application/json")) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Locate a live OpenCode server without confusing the OpenCode 2 web shell
 * (which returns HTTP 200 HTML for unknown v1 paths) with a v1 API server.
 */
export async function findRunningServer(opts = {}) {
  const username = opts.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const envPassword = opts.password ?? process.env.OPENCODE_SERVER_PASSWORD;
  const explicitUrl = opts.url ?? process.env.OPENCODE_SERVER_URL;

  const candidates = [];
  if (explicitUrl) {
    candidates.push({ url: explicitUrl.replace(/\/$/, ""), password: envPassword, source: "explicit" });
  } else {
    const registration = readServiceRegistration(opts.registrationPaths);
    if (registration) {
      candidates.push({
        url: registration.url.replace(/\/$/, ""),
        password: registration.password,
        username,
        pid: registration.pid,
        version: registration.version,
        source: "managed-service",
        registrationPath: registration.registrationPath,
      });
    }

    const config = readOpencodeConfig().data;
    const host = opts.host ?? config.server?.hostname ?? DEFAULT_HOST;
    const port = opts.port ?? Number(process.env.OPENCODE_SERVER_PORT || config.server?.port || 0);
    if (port) candidates.push({
      url: `http://${host}:${port}`,
      password: envPassword,
      username,
      source: "configured-port",
    });
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const auth = basicAuthHeader(candidate.username ?? username, candidate.password);
    const headers = auth ? { Authorization: auth } : {};

    const v2 = await probeJson(candidate.url, "/api/info", headers);
    if (v2 && typeof v2.version === "string") {
      return {
        ...candidate,
        apiVersion: 2,
        version: v2.version,
        pid: v2.pid ?? candidate.pid,
        username: candidate.username ?? username,
      };
    }

    const v1 = await probeJson(candidate.url, "/global/health", headers);
    if (v1 && (v1.healthy === true || typeof v1.version === "string")) {
      return {
        ...candidate,
        apiVersion: 1,
        version: v1.version ?? candidate.version,
        username: candidate.username ?? username,
      };
    }
  }
  return null;
}

function installedMajorVersion() {
  try {
    const r = runCommandSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const text = `${r.stdout || ""} ${r.stderr || ""}`;
    const match = text.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    proc.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => reject(new Error("OpenCode command timed out")), timeoutMs);
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `OpenCode command exited ${code}`));
    });
  });
}

function normalizeV2Message(message) {
  if (!message || typeof message !== "object") return message;
  if (message.info || message.parts) return message;
  const role = message.type === "assistant" ? "assistant" : message.type;
  return {
    info: {
      ...message,
      role,
    },
    parts: Array.isArray(message.content)
      ? message.content.map((part) => ({
          ...part,
          tool: part.tool ?? part.name,
        }))
      : [],
    _v2: message,
  };
}

function parseModelRef(model) {
  if (!model || typeof model === "object") return model;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Invalid OpenCode 2 model "${model}"; expected provider/model[#variant]`);
  }
  const providerID = model.slice(0, slash);
  const modelAndVariant = model.slice(slash + 1);
  const hash = modelAndVariant.lastIndexOf("#");
  if (hash > 0 && hash < modelAndVariant.length - 1) {
    return {
      providerID,
      id: modelAndVariant.slice(0, hash),
      variant: modelAndVariant.slice(hash + 1),
    };
  }
  return { providerID, id: modelAndVariant };
}

/**
 * Find the PID of `opencode serve` listening on `port`, if we can.
 * Returns null on Windows or any detection failure (caller degrades gracefully).
 */
function resolveServePid(port) {
  if (IS_WINDOWS) return null;
  try {
    // macOS + Linux: lsof works the same way. Short timeout so we never block
    // the watcher loop if the tool is slow/missing.
    const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const lines = r.stdout.split("\n").slice(1).filter(Boolean);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // lsof missing or errored — degrade to no pgrep checks
  }
  return null;
}

/**
 * Count direct child processes of `pid`. Returns:
 *   -1 — feature unavailable (Windows, pgrep missing, etc.) — caller should skip check
 *    0 — no children
 *   >0 — that many children
 */
function countChildren(pid) {
  if (!pid || IS_WINDOWS) return -1;
  try {
    const r = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.error) return -1;
    // pgrep exits 1 when no matches (empty stdout) — that's a real "zero", not a failure
    const out = (r.stdout || "").trim();
    if (!out) return 0;
    return out.split("\n").filter(Boolean).length;
  } catch {
    return -1;
  }
}

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host, port) {
  return (await findRunningServer(host || port ? { url: `http://${host ?? DEFAULT_HOST}:${port ?? DEFAULT_PORT}` } : {})) !== null;
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const config = readOpencodeConfig().data;
  const host = opts.host ?? config.server?.hostname ?? DEFAULT_HOST;
  const port = opts.port ?? Number(process.env.OPENCODE_SERVER_PORT || config.server?.port || 0);
  let url = `http://${host}:${port}`;

  const running = await findRunningServer({
    host,
    port,
    url: opts.url,
    registrationPaths: opts.registrationPaths,
  });
  if (running) {
    return { ...running, alreadyRunning: true };
  }

  const major = installedMajorVersion();
  if (major == null) throw new Error("OpenCode CLI not found; install it with: npm install -g @opencode/cli");

  if (major >= 2) {
    // OpenCode 2 owns the lifecycle, random port, password, and registration.
    // Starting a second fixed-port `serve` process bypasses that contract.
    const proc = spawnCommand("opencode", ["service", "start"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    await waitForExit(proc, SERVER_START_TIMEOUT);

    const deadline = Date.now() + SERVER_START_TIMEOUT;
    while (Date.now() < deadline) {
      const managed = await findRunningServer({ registrationPaths: opts.registrationPaths });
      if (managed?.apiVersion === 2) return { ...managed, alreadyRunning: false };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`OpenCode 2 managed service failed to start within ${SERVER_START_TIMEOUT / 1000}s`);
  }

  // Start the server
  // Windows npm shims are .cmd/.ps1; spawn() only resolves those via a shell.
  const proc = spawnCommand("opencode", ["serve", "--hostname", host, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: opts.cwd,
  });
  let startupError;
  proc.on("error", (err) => { startupError = err; });
  proc.stdout.on("data", (chunk) => {
    const match = chunk.toString().match(/https?:\/\/[^\s]+/);
    if (match) url = match[0];
  });
  proc.stderr.on("data", () => {});
  proc.unref();

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    const started = await findRunningServer({ host, port, url });
    if (started?.apiVersion === 1) {
      return { ...started, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s`);
}

/**
 * Create an API client bound to a running OpenCode server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory for x-opencode-directory header
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const apiVersion = opts.apiVersion ?? 1;
  const prefix = apiVersion >= 2 ? "/api" : "";
  const directory = opts.directory;
  const headers = {
    "Content-Type": "application/json",
  };
  if (directory && apiVersion < 2) {
    headers["x-opencode-directory"] = directory;
  }
  const password = opts.password ?? process.env.OPENCODE_SERVER_PASSWORD;
  const username = opts.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  const auth = basicAuthHeader(username, password);
  if (auth) {
    headers.Authorization = auth;
  }

  const endpoint = (path) => `${baseUrl}${prefix}${path}`;

  function unwrap(data) {
    if (apiVersion >= 2 && data && typeof data === "object" && Object.hasOwn(data, "data")) {
      return data.data;
    }
    return data;
  }

  async function request(method, path, body, requestOpts = {}) {
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(endpoint(path), {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw classifyError(err, { baseUrl, startedAt, timeoutMs: REQUEST_TIMEOUT_MS, op: `request ${method} ${path}` });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw classifyError(
        new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`),
        { baseUrl, startedAt, timeoutMs: REQUEST_TIMEOUT_MS, op: `request ${method} ${path}` },
      );
    }
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const data = await res.json();
      return requestOpts.raw ? data : unwrap(data);
    }
    return res.text();
  }

  return {
    baseUrl,
    apiVersion,

    // Health
    health: () => request("GET", apiVersion >= 2 ? "/info" : "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    createSession: (sessionOpts = {}) => {
      const body = { ...sessionOpts };
      if (apiVersion >= 2 && directory && !body.location) {
        body.location = { directory };
      }
      if (apiVersion >= 2 && body.model) body.model = parseModelRef(body.model);
      return request("POST", "/session", body);
    },
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", apiVersion >= 2 ? `/session/${id}/interrupt` : `/session/${id}/abort`),
    getSessionStatus: () => request("GET", apiVersion >= 2 ? "/session/active" : "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before && apiVersion < 2) params.set("before", opts.before);
      if (opts.order && apiVersion >= 2) params.set("order", opts.order);
      if (opts.type && apiVersion >= 2) params.set("type", opts.type);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`)
        .then((messages) => apiVersion >= 2 && Array.isArray(messages)
          ? messages.map(normalizeV2Message)
          : messages);
    },

    /**
     * Send a prompt (synchronous / streaming).
     * Returns the full response text from SSE stream.
     *
     * NOTE: OpenCode's POST /session/:id/message occasionally fails to close
     * its HTTP response body after the session emits its terminal assistant
     * message (observed against glm-5 backend, opencode 1.4.x). Relying on
     * res.json() alone means the caller hangs until AbortSignal fires, which
     * breaks downstream job-completion detection in the companion.
     *
     * Workaround: race the fetch against a session-completion watcher that
     * polls GET /session/:id/message. When the latest assistant message has
     * info.time.completed set AND finish !== undefined, the session is done;
     * we abort the hanging fetch and synthesize the response from the poll.
     */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      if (apiVersion >= 2) {
        if (opts.agent) {
          await request("POST", `/session/${sessionId}/agent`, { agent: opts.agent });
        }
        if (opts.model) {
          await request("POST", `/session/${sessionId}/model`, { model: parseModelRef(opts.model) });
        }

        const startedAt = Date.now();
        const admitted = await request("POST", `/session/${sessionId}/prompt`, { text: promptText });
        const admittedAt = Number(admitted?.time?.created || startedAt);

        const deadline = startedAt + PROMPT_TIMEOUT_MS;
        const pollMs = opts.completionPollMs ?? (Number(process.env.OPENCODE_COMPLETION_POLL_MS) || 5_000);
        let lastSignature = "";
        let lastActivityMs = Date.now();

        while (Date.now() < deadline) {
          let rawMessages;
          try {
            rawMessages = await request(
              "GET",
              `/session/${sessionId}/message?limit=25&order=desc`,
            );
          } catch (err) {
            if (Date.now() - lastActivityMs > IDLE_TIMEOUT_MS) throw err;
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
          }

          const messages = Array.isArray(rawMessages) ? rawMessages : [];
          const admittedIndex = admitted?.id
            ? messages.findIndex((message) => message?.id === admitted.id)
            : -1;
          const fresh = admittedIndex >= 0
            ? messages.slice(0, admittedIndex + 1)
            : messages.filter((m) => Number(m?.time?.created || 0) >= admittedAt);
          const signature = JSON.stringify(fresh.map((m) => [
            m?.id,
            m?.type,
            m?.time?.completed,
            m?.finish,
            Array.isArray(m?.content) ? m.content.length : 0,
          ]));
          if (signature !== lastSignature) {
            lastSignature = signature;
            lastActivityMs = Date.now();
          }

          const idle = fresh.find((m) => m?.type === "idle");
          if (idle) {
            const assistant = fresh.find((m) => m?.type === "assistant");
            if (idle.outcome === "failed") {
              const detail = idle.error?.message || idle.error?.name || "OpenCode session failed";
              throw new Error(detail);
            }
            if (!assistant) {
              throw new Error(`OpenCode session became ${idle.outcome} without an assistant response`);
            }
            return normalizeV2Message(assistant);
          }

          if (Date.now() - lastActivityMs > IDLE_TIMEOUT_MS) {
            throw new Error(`session idle ${Math.floor((Date.now() - lastActivityMs) / 1000)}s`);
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
        throw new Error(`OpenCode prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`);
      }

      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      if (opts.system) body.system = opts.system;

      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(new Error("prompt timeout")), PROMPT_TIMEOUT_MS);
      const startedAt = Date.now();
      // Grace period so we don't mistake "session had no prior activity" for
      // completion before the new prompt has even begun generating.
      const MIN_POLL_DELAY_MS = 5_000;
      const POLL_INTERVAL_MS = Number(process.env.OPENCODE_COMPLETION_POLL_MS) || 5_000;

      const fetchPromise = (async () => {
        const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`OpenCode prompt failed ${res.status}: ${text}`);
        }
        return { source: "fetch", data: await res.json() };
      })();

      const watcherPromise = (async () => {
        // Wait briefly so the new generation has a chance to start and we
        // don't latch onto a stale completed message from before this prompt.
        await new Promise((r) => setTimeout(r, MIN_POLL_DELAY_MS));

        // Resolve the opencode serve PID once so we can check for child
        // processes later. If this fails (Windows, no lsof, permissions)
        // we silently skip the pgrep-based stuck detector — idle timeout
        // still covers most cases.
        const urlObj = (() => {
          try { return new URL(baseUrl); } catch { return null; }
        })();
        const port = Number(urlObj?.port) || DEFAULT_PORT;
        const opencodePid = resolveServePid(port);

        let prevSig = "";
        let lastActivityMs = Date.now();
        let pgrepMissCount = 0;

        while (!ac.signal.aborted) {
          try {
            const params = new URLSearchParams({ limit: "1" });
            const r = await fetch(
              `${baseUrl}/session/${sessionId}/message?${params.toString()}`,
              { headers, signal: AbortSignal.timeout(10_000) },
            );
            if (r.ok) {
              const arr = await r.json();
              const last = Array.isArray(arr) ? arr[arr.length - 1] : null;
              const info = last?.info;
              const parts = Array.isArray(last?.parts) ? last.parts : [];
              const completed = typeof info?.time?.completed === "number" ? info.time.completed : 0;
              const hasTerminalFinish = typeof info?.finish === "string";
              // Most recent tool part — the one actually "running" if any.
              let lastTool = null;
              for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i]?.type === "tool") { lastTool = parts[i]; break; }
              }

              // Activity signature: any change here = progress was made.
              const sig = JSON.stringify({
                mid: info?.id,
                created: info?.time?.created,
                completed: info?.time?.completed,
                parts: parts.length,
                tStatus: lastTool?.state?.status,
                tOutLen: (lastTool?.state?.output || "").length,
              });
              if (sig !== prevSig) {
                lastActivityMs = Date.now();
                prevSig = sig;
                pgrepMissCount = 0;
              }

              // Completion signal: assistant message created after our prompt
              // started. Some OpenCode versions omit `finish` on terminal messages.
              if (
                info &&
                info.role === "assistant" &&
                completed >= startedAt &&
                (STRICT_TERMINAL ? hasTerminalFinish : hasTerminalFinish || completed > 0)
              ) {
                return { source: "watcher", data: last };
              }

              // Bash-tool stuck detector: latest tool is bash in status=running
              // but opencode serve has zero children for N consecutive polls.
              // This is the signature of the "ask permission deadlock" bug
              // (sst/opencode#14473): the shell process already exited cleanly
              // but tool state never flipped to completed.
              if (
                opencodePid &&
                lastTool?.tool === "bash" &&
                lastTool?.state?.status === "running"
              ) {
                const n = countChildren(opencodePid);
                if (n === 0) {
                  pgrepMissCount += 1;
                  if (pgrepMissCount >= PGREP_MISS_THRESHOLD) {
                    ac.abort(
                      new Error(
                        `bash tool stuck — opencode serve (pid ${opencodePid}) has no child for ${pgrepMissCount} polls while tool.status=running`,
                      ),
                    );
                    throw new Error("bash tool stuck (no child)");
                  }
                } else if (n > 0) {
                  pgrepMissCount = 0;
                }
                // n === -1 → feature unavailable, don't count either way
              }

              // Idle timeout: nothing happened in the session for too long.
              // Covers all tool types (not just bash), including non-pgrep
              // platforms (Windows).
              const idleMs = Date.now() - lastActivityMs;
              if (idleMs > IDLE_TIMEOUT_MS) {
                const liveChildren = opencodePid ? countChildren(opencodePid) : 0;
                if (liveChildren > 0) {
                  lastActivityMs = Date.now();
                  process.stderr.write(
                    `opencode watcher: session idle ${Math.floor(idleMs / 1000)}s, but opencode serve (pid ${opencodePid}) has ${liveChildren} child process(es); continuing\n`,
                  );
                } else {
                  ac.abort(
                    new Error(
                      `session idle ${Math.floor(idleMs / 1000)}s > ${IDLE_TIMEOUT_MS / 1000}s`,
                    ),
                  );
                  throw new Error("session idle timeout");
                }
              }
            }
          } catch (err) {
            // If we aborted above, propagate so the outer race sees a failure.
            if (ac.signal.aborted) throw err;
            // Otherwise it's a transient network/server blip — keep polling.
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        throw new Error("watcher aborted");
      })();

      // Settle-wrap each so a single rejection doesn't lose the other side.
      // Server-side 5-min POST cap means fetchPromise often rejects LONG
      // before the agent is actually done; we must still wait on the watcher.
      const wrap = (p, via) =>
        p.then(
          (v) => ({ ok: true, via, data: v.data }),
          (err) => ({ ok: false, via, err }),
        );
      const runFetch = wrap(fetchPromise, "fetch");
      const runWatcher = wrap(watcherPromise, "watcher");

      try {
        const first = await Promise.race([runFetch, runWatcher]);
        if (first.ok) {
          ac.abort();
          fetchPromise.catch(() => {});
          watcherPromise.catch(() => {});
          return first.data;
        }
        // First to settle was a failure — the other promise may still succeed.
        // Do NOT abort yet: in particular, the watcher needs to keep polling
        // when the POST was killed by the server's 5-min cap but generation
        // is still running.
        const second = first.via === "fetch" ? await runWatcher : await runFetch;
        ac.abort();
        fetchPromise.catch(() => {});
        watcherPromise.catch(() => {});
        if (second.ok) return second.data;
        // Both failed — surface the more informative error. Prefer the
        // fetch error because it usually has the HTTP status/body.
        const rawErr = first.via === "fetch" ? first.err : second.err;
        throw classifyError(rawErr, {
          baseUrl,
          startedAt,
          timeoutMs: PROMPT_TIMEOUT_MS,
          op: "sendPrompt",
        });
      } finally {
        clearTimeout(timeoutId);
      }
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     */
    sendPromptAsync: async (sessionId, promptText, opts = {}) => {
      if (apiVersion >= 2) {
        if (opts.agent) {
          await request("POST", `/session/${sessionId}/agent`, { agent: opts.agent });
        }
        if (opts.model) {
          await request("POST", `/session/${sessionId}/model`, { model: parseModelRef(opts.model) });
        }
        return request("POST", `/session/${sessionId}/prompt`, { text: promptText });
      }
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      return request("POST", `/session/${sessionId}/prompt_async`, body);
    },

    // Agents
    listAgents: () => request("GET", directory && apiVersion >= 2
      ? `/agent?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
      : "/agent"),

    // Providers
    listProviders: () => request("GET", directory && apiVersion >= 2
      ? `/provider?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
      : "/provider"),
    getProviderAuth: () => apiVersion >= 2
      ? request("GET", "/integration")
      : request("GET", "/provider/auth"),

    // Config
    getConfig: () => request("GET", "/config"),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(endpoint("/event"), {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      return res.body;
    },
  };
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const server = await ensureServer(opts);
  const client = createClient(server.url, {
    directory: opts.cwd,
    apiVersion: server.apiVersion,
    username: server.username,
    password: server.password,
  });
  return {
    ...client,
    serverInfo: {
      url: server.url,
      apiVersion: server.apiVersion,
      version: server.version,
      pid: server.pid,
      source: server.source,
    },
  };
}

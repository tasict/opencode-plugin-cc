// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawn, spawnSync } from "node:child_process";

// Re-export for spec-compliance / discoverability: probeSessionTerminal lives
// in auto-heal.mjs because it is tightly coupled to heal-decision logic, but
// conceptually it is a server probe.
export { probeSessionTerminal } from "./auto-heal.mjs";

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Long-running tasks (e.g. engine builds, large refactors) can easily exceed
// the old 5-10 min caps, causing `fetch failed` at a fixed deadline. Default
// PROMPT_TIMEOUT_MS to 4 hours — absolute safety cap. Real stall detection
// lives in the watcher via IDLE_TIMEOUT_MS + pgrep child-process check.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 1_800_000;
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS) || 14_400_000;
// How long a session may go without ANY activity signal before we assume it
// is stuck. Activity = new message, new parts, tool output growth, status
// change. Default 15 min — long enough for most silent-but-alive tasks.
const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 900_000;
// Bash-tool "no child process" consecutive-miss threshold. If the latest
// tool is a bash in status=running but opencode serve has zero child
// processes for N polls in a row, declare stuck. 3 × 5s = 15s grace.
const PGREP_MISS_THRESHOLD = Number(process.env.OPENCODE_PGREP_MISS_THRESHOLD) || 3;

const IS_WINDOWS = process.platform === "win32";

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
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
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
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://${host}:${port}`;

  if (await isServerRunning(host, port)) {
    return { url, alreadyRunning: true };
  }

  // Start the server
  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: opts.cwd,
  });
  proc.unref();

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (await isServerRunning(host, port)) {
      return { url, pid: proc.pid, alreadyRunning: false };
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
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.directory) {
    headers["x-opencode-directory"] = opts.directory;
  }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    createSession: (opts = {}) => request("POST", "/session", opts),
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", `/session/${id}/abort`),
    getSessionStatus: () => request("GET", "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before) params.set("before", opts.before);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`);
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
              // started, with a terminal `finish` field populated.
              if (
                info &&
                info.role === "assistant" &&
                typeof info.time?.completed === "number" &&
                info.time.completed >= startedAt &&
                typeof info.finish === "string"
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
                ac.abort(
                  new Error(
                    `session idle ${Math.floor(idleMs / 1000)}s > ${IDLE_TIMEOUT_MS / 1000}s`,
                  ),
                );
                throw new Error("session idle timeout");
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
        throw first.via === "fetch" ? first.err : second.err;
      } finally {
        clearTimeout(timeoutId);
      }
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     */
    sendPromptAsync: (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      return request("POST", `/session/${sessionId}/prompt_async`, body);
    },

    // Agents
    listAgents: () => request("GET", "/agent"),

    // Providers
    listProviders: () => request("GET", "/provider"),
    getProviderAuth: () => request("GET", "/provider/auth"),

    // Config
    getConfig: () => request("GET", "/config"),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(`${baseUrl}/event`, {
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
  const { url } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url } };
}

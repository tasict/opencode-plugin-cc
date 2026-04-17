// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawn } from "node:child_process";

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Long-running tasks (e.g. engine builds, large refactors) can easily exceed
// the old 5-10 min caps, causing `fetch failed` at a fixed deadline. Default
// to 30 min; override via env for even longer workloads.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 1_800_000;
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS) || 1_800_000;

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
              // Only treat assistant messages created *after* this prompt
              // started as a completion signal for this call.
              if (
                info &&
                info.role === "assistant" &&
                typeof info.time?.completed === "number" &&
                info.time.completed >= startedAt &&
                typeof info.finish === "string"
              ) {
                return { source: "watcher", data: last };
              }
            }
          } catch {
            // Ignore transient poll errors; keep waiting.
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        throw new Error("watcher aborted");
      })();

      try {
        const winner = await Promise.race([fetchPromise, watcherPromise]);
        // Whichever arrived first, cancel the other.
        ac.abort();
        // Swallow the loser's rejection to avoid unhandled rejection noise.
        fetchPromise.catch(() => {});
        watcherPromise.catch(() => {});
        return winner.data;
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

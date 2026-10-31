import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  createClient,
  findRunningServer,
  isServerRunning,
  readServiceRegistration,
} from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { probeSessionTerminal } from "../plugins/opencode/scripts/lib/auto-heal.mjs";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`, port: address.port };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("OpenCode server compatibility", () => {
  it("does not mistake a 200 HTML web shell for the v1 API", async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>OpenCode</title>");
    });

    assert.equal(await isServerRunning("127.0.0.1", port), false);
  });

  it("reads a managed-service registration", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-plugin-test-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "service.json");
    fs.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:1234", password: "secret" }));

    const registration = readServiceRegistration([file]);
    assert.equal(registration.url, "http://127.0.0.1:1234");
    assert.equal(registration.password, "secret");
    assert.equal(registration.registrationPath, file);
  });

  it("default health check discovers the registered service without a port", async () => {
    const { url } = await listen((req, res) => json(res, 200, { version: "2.1.4" }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-service-"));
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    cleanups.push(() => { if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; fs.rmSync(dir, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(dir, "opencode"));
    fs.writeFileSync(path.join(dir, "opencode", "service.json"), JSON.stringify({ url }));
    assert.equal(await isServerRunning(), true);
  });

  it("discovers a configured port instead of a hard-coded port", async () => {
    const { port, url } = await listen((req, res) => req.url === "/global/health"
      ? json(res, 200, { healthy: true, version: "1.4.0" }) : json(res, 404, {}));
    const found = await findRunningServer({ host: "127.0.0.1", port, registrationPaths: [] });
    assert.equal(found.url, url);
    assert.equal(found.apiVersion, 1);
    assert.equal(found.source, "configured-port");
  });

  it("discovers and drives the OpenCode 2 API", async () => {
    const password = "test-password";
    const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const seen = [];
    const { url } = await listen(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

      if (req.headers.authorization !== expectedAuth) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/api/info") {
        return json(res, 200, { version: "2.1.4", pid: 42, urls: [] });
      }
      if (req.method === "POST" && req.url === "/api/session") {
        return json(res, 200, { data: { id: "ses_test", location: JSON.parse(body).location } });
      }
      if (req.method === "POST" && req.url === "/api/session/ses_test/agent") {
        res.writeHead(204); return res.end();
      }
      if (req.method === "POST" && req.url === "/api/session/ses_test/model") {
        res.writeHead(204); return res.end();
      }
      if (req.method === "POST" && req.url === "/api/session/ses_test/prompt") {
        return json(res, 200, { data: { id: "msg_user", type: "user" } });
      }
      if (req.method === "GET" && req.url.startsWith("/api/session/ses_test/message?")) {
        const now = Date.now();
        return json(res, 200, {
          data: [
            { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: now + 2 } },
            {
              id: "msg_assistant",
              type: "assistant",
              agent: "build",
              model: { providerID: "opencode-go", id: "beam-free", variant: "max" },
              time: { created: now + 1, completed: now + 2 },
              finish: "stop",
              content: [{ type: "text", text: "done" }],
            },
          ],
          cursor: { previous: null, next: null },
        });
      }
      return json(res, 404, { error: `${req.method} ${req.url}` });
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-plugin-test-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const registrationPath = path.join(dir, "service.json");
    fs.writeFileSync(registrationPath, JSON.stringify({ url, password, version: "2.1.4", pid: 42 }));

    const found = await findRunningServer({ registrationPaths: [registrationPath] });
    assert.equal(found.apiVersion, 2);
    assert.equal(found.url, url);

    const client = createClient(found.url, {
      apiVersion: found.apiVersion,
      password: found.password,
      username: found.username,
      directory: "C:\\work",
    });
    const session = await client.createSession({ title: "test" });
    assert.deepEqual(session.location, { directory: "C:\\work" });

    const response = await client.sendPrompt(session.id, "hello", {
      agent: "build",
      model: "opencode-go/beam-free#max",
      completionPollMs: 1,
    });
    assert.equal(response.info.role, "assistant");
    assert.equal(response.parts[0].text, "done");

    const modelRequest = seen.find((x) => x.url.endsWith("/model"));
    assert.deepEqual(JSON.parse(modelRequest.body), {
      model: { providerID: "opencode-go", id: "beam-free", variant: "max" },
    });
    assert.ok(seen.every((x) => x.auth === expectedAuth));

    const terminal = await probeSessionTerminal(url, session.id, Date.now() - 1_000, {
      Authorization: expectedAuth,
    });
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.text, "done");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPromptBody,
  buildFilePart,
} from "../plugins/opencode/scripts/lib/opencode-server.mjs";

describe("buildFilePart", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-file-part-"));
  const filePath = path.join(tmp, "notes.md");
  const dirPath = path.join(tmp, "sub dir");
  fs.writeFileSync(filePath, "hello");
  fs.mkdirSync(dirPath);

  it("builds a text/plain file:// part for a file", () => {
    const part = buildFilePart(filePath);
    assert.equal(part.type, "file");
    assert.equal(part.mime, "text/plain");
    assert.equal(part.filename, "notes.md");
    assert.equal(part.url, pathToFileURL(filePath).href);
  });

  it("escapes special characters in the file URL", () => {
    const part = buildFilePart(dirPath);
    assert.equal(part.url, pathToFileURL(dirPath).href);
    assert.ok(part.url.includes("%20"), "spaces should be percent-encoded");
  });

  it("marks directories as application/x-directory", () => {
    const part = buildFilePart(dirPath);
    assert.equal(part.mime, "application/x-directory");
    assert.equal(part.filename, "sub dir");
  });

  it("throws for missing paths", () => {
    assert.throws(() => buildFilePart(path.join(tmp, "nope.txt")), /File not found/);
  });
});

describe("buildPromptBody", () => {
  it("wraps prompt text and passes agent through", () => {
    const body = buildPromptBody("fix the bug", { agent: "build" });
    assert.deepEqual(body, {
      parts: [{ type: "text", text: "fix the bug" }],
      agent: "build",
    });
  });

  it("converts a provider/model string to the API ModelRef object", () => {
    const body = buildPromptBody("hi", { model: "anthropic/claude-sonnet-4-5" });
    assert.deepEqual(body.model, {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    });
  });

  it("keeps model IDs containing slashes intact", () => {
    const body = buildPromptBody("hi", { model: "lmstudio/google/gemma-3" });
    assert.deepEqual(body.model, {
      providerID: "lmstudio",
      modelID: "google/gemma-3",
    });
  });

  it("rejects model strings without a provider", () => {
    assert.throws(() => buildPromptBody("hi", { model: "claude-sonnet" }), /provider\/model/);
    assert.throws(() => buildPromptBody("hi", { model: "anthropic/" }), /provider\/model/);
    assert.throws(() => buildPromptBody("hi", { model: "/claude" }), /provider\/model/);
  });

  it("passes a ModelRef object through unchanged", () => {
    const ref = { providerID: "openai", modelID: "gpt-5.2" };
    const body = buildPromptBody("hi", { model: ref });
    assert.equal(body.model, ref);
  });

  it("forwards variant like `opencode run --variant`", () => {
    const body = buildPromptBody("hi", { variant: "high" });
    assert.equal(body.variant, "high");
  });

  it("supports model, variant, agent, and system together", () => {
    const body = buildPromptBody("hi", {
      agent: "plan",
      model: "opencode/gpt-5.1-codex",
      variant: "max",
      system: "extra",
    });
    assert.deepEqual(body, {
      parts: [{ type: "text", text: "hi" }],
      agent: "plan",
      model: { providerID: "opencode", modelID: "gpt-5.1-codex" },
      variant: "max",
      system: "extra",
    });
  });

  it("places attachments before the text part, like `opencode run`", () => {
    const file = { type: "file", url: "file:///tmp/a.png", filename: "a.png", mime: "text/plain" };
    const body = buildPromptBody("hi", { attachments: [file] });
    assert.deepEqual(body.parts, [file, { type: "text", text: "hi" }]);
  });

  it("omits unset options", () => {
    const body = buildPromptBody("hi", {});
    assert.deepEqual(body, { parts: [{ type: "text", text: "hi" }] });
  });
});

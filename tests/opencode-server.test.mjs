import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptBody } from "../plugins/opencode/scripts/lib/opencode-server.mjs";

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

  it("omits unset options", () => {
    const body = buildPromptBody("hi", {});
    assert.deepEqual(body, { parts: [{ type: "text", text: "hi" }] });
  });
});

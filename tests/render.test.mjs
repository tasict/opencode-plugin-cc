import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderStatus, renderResult, renderReview, renderSetup } from "../plugins/opencode/scripts/lib/render.mjs";

describe("renderStatus", () => {
  it("renders empty state", () => {
    const output = renderStatus({ running: [], latestFinished: null, recent: [] });
    assert.ok(output.includes("No OpenCode jobs"));
  });

  it("renders running jobs", () => {
    const output = renderStatus({
      running: [{ id: "task-1", type: "task", phase: "investigating", elapsed: "2m 30s" }],
      latestFinished: null,
      recent: [],
    });
    assert.ok(output.includes("task-1"));
    assert.ok(output.includes("investigating"));
  });
});

describe("renderReview", () => {
  it("renders approve verdict", () => {
    const output = renderReview({ verdict: "approve", summary: "Looks good", findings: [] });
    assert.ok(output.includes("PASS"));
    assert.ok(output.includes("No findings"));
  });

  it("renders findings", () => {
    const output = renderReview({
      verdict: "needs-attention",
      summary: "Issues found",
      findings: [{
        file: "src/api.ts",
        line_start: 10,
        line_end: 15,
        severity: "high",
        title: "SQL injection",
        body: "User input not sanitized",
        confidence: 0.9,
        recommendation: "Use parameterized queries",
      }],
    });
    assert.ok(output.includes("NEEDS ATTENTION"));
    assert.ok(output.includes("SQL injection"));
    assert.ok(output.includes("src/api.ts"));
    assert.ok(output.includes("90%"));
  });
});

describe("renderSetup", () => {
  it("renders installed status", () => {
    const output = renderSetup({ installed: true, version: "1.3.9", serverRunning: true, providers: ["anthropic"], reviewGate: false });
    assert.ok(output.includes("Yes"));
    assert.ok(output.includes("1.3.9"));
    assert.ok(output.includes("anthropic"));
  });

  it("renders not installed status", () => {
    const output = renderSetup({ installed: false });
    assert.ok(output.includes("No"));
  });
});

describe("renderResult", () => {
  it("renders completed job", () => {
    const output = renderResult(
      { id: "task-1", type: "task", status: "completed", elapsed: "5m" },
      { rendered: "Fixed the bug in api.ts" }
    );
    assert.ok(output.includes("task-1"));
    assert.ok(output.includes("Fixed the bug"));
  });

  it("renders failed job", () => {
    const output = renderResult(
      { id: "task-2", type: "task", status: "failed", elapsed: "1m", errorMessage: "Connection timeout" },
      null
    );
    assert.ok(output.includes("Connection timeout"));
  });
});

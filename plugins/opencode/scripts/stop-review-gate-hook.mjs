#!/usr/bin/env node

// Stop review gate hook for the OpenCode companion.
// When enabled, runs a targeted OpenCode review on Claude's response before
// allowing the session to stop. If issues are found, the stop is blocked.

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState } from "./lib/state.mjs";
import { isServerRunning, connect } from "./lib/opencode-server.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

async function main() {
  const workspace = await resolveWorkspace();

  // Check if review gate is enabled
  const state = loadState(workspace);
  if (!state.config?.reviewGate) {
    // Gate is disabled, allow stop
    console.log("ALLOW: Review gate is disabled.");
    return;
  }

  // Check if server is available
  if (!(await isServerRunning())) {
    console.log("ALLOW: OpenCode server not running.");
    return;
  }

  // Read the Claude response from stdin (piped by Claude Code)
  let claudeResponse = "";
  if (!process.stdin.isTTY) {
    claudeResponse = await new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      // Timeout after 5 seconds of no input
      setTimeout(() => resolve(data), 5000);
    });
  }

  if (!claudeResponse.trim()) {
    console.log("ALLOW: No response to review.");
    return;
  }

  // Load the stop-review-gate prompt template
  const templatePath = path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md");
  const template = fs.readFileSync(templatePath, "utf8");
  const prompt = template.replace(
    "{{CLAUDE_RESPONSE_BLOCK}}",
    `<claude_response>\n${claudeResponse}\n</claude_response>`
  );

  try {
    const client = await connect({ cwd: workspace });
    const session = await client.createSession({ title: "Stop Review Gate" });

    const response = await client.sendPrompt(session.id, prompt, {
      agent: "plan", // read-only review
    });

    // Extract the verdict
    const text = extractText(response);
    const firstLine = text.trim().split("\n")[0];

    if (firstLine.startsWith("BLOCK")) {
      // Output BLOCK to stderr so Claude Code sees it
      process.stderr.write(`OpenCode review gate: ${firstLine}\n`);
      console.log(firstLine);
      process.exit(1); // Non-zero exit blocks the stop
    } else {
      console.log(firstLine || "ALLOW: No issues found.");
    }
  } catch (err) {
    // On error, allow the stop (don't block on failures)
    console.log(`ALLOW: Review gate error: ${err.message}`);
  }
}

function extractText(response) {
  if (typeof response === "string") return response;
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(response);
}

main().catch((err) => {
  console.log(`ALLOW: Unhandled error: ${err.message}`);
  process.exit(0);
});

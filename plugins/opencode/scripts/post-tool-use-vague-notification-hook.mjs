#!/usr/bin/env node

// PostToolUse hook: watches for Agent tool responses that look like a
// "vague" rescue-task notification — i.e. the rescue subagent returned a
// placeholder string (Monitor started / Waiting for completion / Task
// forwarded in background) instead of the companion's rendered terminal
// report (`## Job: task-xxx` + `### Output`).
//
// When detected, inject an additionalContext reminder telling Claude to
// poll companion status / session messages for the actual terminal
// result, rather than treating the vague result as final.
//
// Why in a hook: even with the updated opencode-rescue.md dispatch-and-
// poll rules, edge cases (network blips, unexpected subagent early exit,
// older cached subagent prompt) can still surface placeholder text. This
// hook is a belt-and-suspenders safety net for the main thread so it
// never silently accepts a vague "completion" as real.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractResponseText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response === "object") {
    if (typeof response.result === "string") return response.result;
    if (typeof response.content === "string") return response.content;
    return JSON.stringify(response);
  }
  return String(response);
}

// Heuristics — any one of these patterns anywhere in the response text
// marks it as a vague placeholder. These are phrases the rescue subagent
// (or its older cached variants) emits when it gives up on waiting.
const VAGUE_PATTERNS = [
  /Monitor started for (?:both |all )?rescue tasks?/i,
  /Waiting for (?:the forwarded task|completion|the job)/i,
  /poll loop is (?:still )?running in (?:the )?background/i,
  /Task forwarded to OpenCode \(background ID/i,
  /I'll (?:wait for|surface results when)/i,
  /will surface results when (?:they|it) reach/i,
];

// A response with the real companion terminal report contains these
// markers (from `companion result`). Presence of any of them means the
// result is real and we should NOT inject the reminder.
const REAL_RESULT_MARKERS = [
  /## Job: task-[a-z0-9-]+/i,
  /### Output/,
  /\bStatus:\s*(?:completed|failed|cancelled)/i,
];

// Only fire for responses that are clearly from the opencode companion
// path (avoid false positives on arbitrary Agent output).
const OPENCODE_MARKERS = [
  /OpenCode task (?:started|forwarded|completed)/i,
  /opencode-companion\.mjs/,
  /opencode:opencode-rescue/,
  /opencode rescue/i,
  /task-[a-z0-9]{6,}-[a-z0-9]{4,}/,
];

// Companion task ids look like `task-moNNNNNN-NNNNNN`.
const TASK_ID_RE = /\btask-[a-z0-9]{6,}-[a-z0-9]{4,}\b/g;

function resolveCompanionPath() {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), "opencode-companion.mjs");
}

function buildReminder(taskIds, companionPath) {
  const idLine = taskIds.length
    ? `Likely task id(s) seen in response: ${taskIds.join(", ")}.`
    : "No task id was visible in the vague response — check most recent companion job with `node \"" + companionPath + "\" list` style introspection (or `ls -t /Users/harvest/.claude/plugins/data/opencode-tasict-*/state/*/jobs/*.log | head -3`).";
  return [
    "<opencode-vague-notification-detected>",
    "The rescue subagent you just dispatched returned a placeholder string instead of the companion's rendered terminal report. Do NOT treat this as a completed task.",
    "",
    idLine,
    "",
    "Before your next response, verify the task actually reached terminal state:",
    "",
    "1. Status check:",
    `   node "${companionPath}" status <task-id> --json | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{try{const j=JSON.parse(s).job||{};process.stdout.write(j.status+\"|\"+j.phase+\"|\"+j.elapsed)}catch(e){process.stdout.write(\"parse-err\")}})'`,
    "",
    "2. If still `running`, inspect live tool-call trace (opencode-result-handling skill, Layer 2):",
    "   `curl -s http://localhost:4096/session/<opencodeSessionId>/message | python3 ...`",
    "   `<opencodeSessionId>` is in the status JSON's `job.opencodeSessionId`.",
    "",
    "3. Once status is terminal (`completed` / `failed` / `cancelled`), fetch the real result:",
    `   node "${companionPath}" result <task-id>`,
    "",
    "Only after you have the companion's rendered terminal report (contains `## Job:` + `### Output` markers) should you report back to the user.",
    "</opencode-vague-notification-detected>",
  ].join("\n");
}

function main() {
  const input = readHookInput();
  const toolName = input.tool_name || "";
  // Vague notifications come from the Agent wrapper's summary text.
  if (toolName !== "Agent") return;

  const response = extractResponseText(input.tool_response);
  if (!response) return;

  // Must smell like an opencode response at all.
  if (!OPENCODE_MARKERS.some((r) => r.test(response))) return;

  // If it already has a real-result marker, do not fire.
  if (REAL_RESULT_MARKERS.some((r) => r.test(response))) return;

  // Must match at least one vague pattern.
  if (!VAGUE_PATTERNS.some((r) => r.test(response))) return;

  // Extract any task ids that might help the main thread poll.
  const ids = [...new Set(response.match(TASK_ID_RE) || [])];

  const companionPath = resolveCompanionPath();
  const additionalContext = buildReminder(ids, companionPath);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    }),
  );
}

try {
  main();
} catch {
  // Best-effort — never block tool use on hook failure.
  process.exit(0);
}

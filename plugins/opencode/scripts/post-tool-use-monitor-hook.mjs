#!/usr/bin/env node

// PostToolUse hook: watches for rescue-task dispatch in tool responses and
// injects a reminder that tells Claude to (a) start/refresh a Monitor
// covering the new task id(s), and (b) fetch + summarize the companion
// `result` payload when Monitor reports a terminal state.
//
// Why in a hook: the main Claude thread has no built-in way to observe
// background codex/opencode tasks. Without this, dispatching a rescue is
// fire-and-forget — the user has to ask for progress manually. The hook
// makes every rescue dispatch automatically get monitored and reported
// on, matching the UX of in-process subagents.

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

// Companion task ids look like `task-moNNNNNN-NNNNNN`.
const TASK_ID_RE = /\btask-[a-z0-9]{6,}-[a-z0-9]{4,}\b/g;

// Only react to responses that are unambiguously from the opencode companion,
// to avoid false positives on arbitrary text containing a task-like token.
const OPENCODE_MARKERS = [
  /OpenCode task started/i,
  /opencode-companion\.mjs/,
  /opencode:opencode-rescue/,
  /opencode rescue/i,
];

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

function resolveCompanionPath() {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), "opencode-companion.mjs");
}

function buildMonitorScript(ids, companionPath) {
  const quoted = ids.map((id) => `"${id}"`).join(" ");
  // The poll loop runs inside a Monitor child process:
  //  - polls companion status JSON per id every 30s
  //  - emits a single line whenever status/phase changes
  //  - on terminal state, fetches `companion result <id>`, truncates to
  //    a bounded size, and prints it as multi-line output; Monitor batches
  //    lines within ~200ms into one notification, so the main thread
  //    sees a single event carrying "task done + full summary" without
  //    needing a follow-up tool call to fetch the result
  //  - exits when every tracked id is terminal (Monitor process ends
  //    cleanly, no runaway background poller)
  return [
    "set -u",
    `COMP=${JSON.stringify(companionPath)}`,
    `IDS=(${quoted})`,
    "RESULT_MAX_CHARS=${OPENCODE_MONITOR_RESULT_CHARS:-1500}",
    "declare -A prev",
    'for id in "${IDS[@]}"; do prev[$id]=""; done',
    "while true; do",
    "  all_done=1",
    '  for id in "${IDS[@]}"; do',
    '    json=$(node "$COMP" status "$id" --json 2>/dev/null || printf "{}")',
    "    st=$(printf '%s' \"$json\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{try{const j=JSON.parse(s);console.log((j.job?.status||\"unknown\")+\"/\"+(j.job?.phase||\"\"))}catch(e){console.log(\"parse-err/\")}})')",
    '    if [ "$st" != "${prev[$id]}" ]; then',
    '      ts=$(date +%H:%M:%S)',
    '      echo "[$ts] opencode $id: ${prev[$id]:-none} → $st"',
    '      case "$st" in',
    "        completed/*|failed/*|cancelled/*)",
    '          result=$(node "$COMP" result "$id" 2>/dev/null || true)',
    "          # Truncate defensively so Monitor output stays bounded.",
    '          summary=$(printf "%s" "$result" | head -c "$RESULT_MAX_CHARS")',
    '          echo "[$ts] opencode $id TERMINAL=$st — result summary:"',
    '          echo "--- result-begin $id ---"',
    '          printf "%s" "$summary"',
    '          echo ""',
    '          echo "--- result-end $id ---"',
    "          ;;",
    "      esac",
    '      prev[$id]="$st"',
    "    fi",
    '    case "$st" in completed/*|failed/*|cancelled/*) ;; *) all_done=0 ;; esac',
    "  done",
    "  if [ $all_done -eq 1 ]; then",
    "    echo \"[$(date +%H:%M:%S)] opencode: all tracked tasks terminal — exiting monitor\"",
    "    break",
    "  fi",
    "  sleep 30",
    "done",
  ].join("\n");
}

function buildReminder(ids, script) {
  const idList = ids.join(", ");
  return [
    "<opencode-rescue-auto-monitor>",
    `You just dispatched ${ids.length} opencode rescue task(s): ${idList}.`,
    "",
    "Before you respond to the user, start a persistent Monitor so this session can observe task completion automatically. Use the `Monitor` tool:",
    "",
    '- description: "opencode rescue task state"',
    "- persistent: true",
    "- timeout_ms: 3600000",
    "- command: the shell loop below, verbatim",
    "",
    "```bash",
    script,
    "```",
    "",
    "Behavior contract — follow this without being asked:",
    "1. If a Monitor is already running in this session covering other task ids, stop it (`TaskStop`) and start a new one whose IDS array is the union of all currently-running rescue task ids. One Monitor per session.",
    "2. The Monitor script above already fetches `companion result <id>` and emits the summary inline on terminal state — each terminal event carries the full result block between `--- result-begin ---` and `--- result-end ---` markers. You do NOT need to run a follow-up Bash call to get the result; just read the Monitor event and surface a short summary of what the rescue task did (or failed at) to the user.",
    "3. If the user explicitly asked you to skip monitoring, do nothing here.",
    "</opencode-rescue-auto-monitor>",
  ].join("\n");
}

function main() {
  const input = readHookInput();
  const toolName = input.tool_name || "";
  // Rescue dispatch happens through the Agent tool wrapper; main thread may
  // also call companion directly via Bash. Ignore other tools.
  if (toolName !== "Agent" && toolName !== "Bash") return;

  const response = extractResponseText(input.tool_response);
  if (!response) return;
  if (!OPENCODE_MARKERS.some((r) => r.test(response))) return;

  const ids = [...new Set(response.match(TASK_ID_RE) || [])];
  if (ids.length === 0) return;

  const companionPath = resolveCompanionPath();
  const script = buildMonitorScript(ids, companionPath);
  const additionalContext = buildReminder(ids, script);

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

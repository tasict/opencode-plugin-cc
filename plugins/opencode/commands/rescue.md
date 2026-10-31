---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the OpenCode rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <provider/model>] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*)
---

Route this request to the `opencode:opencode-rescue` subagent.
The final user-visible response must be OpenCode's output verbatim.

Raw user request:
$ARGUMENTS

Execution contract:
- Route to the thin forwarder in the requested execution mode.
- Pass user text through quoted stdin or a prompt file; never concatenate shell text.
- Preserve --model provider/model#variant, --agent, --full-access, --no-full-access,
  --no-repair-config, --standalone, --worktree <branch>, and --incident-log <path>.
- Map --resume to --resume-last. Otherwise start fresh; do not ask routine confirmation.
- The forwarder launches one background companion task, polls cheap status and
  returns one final JSON digest. It does not inspect the repository or full logs.

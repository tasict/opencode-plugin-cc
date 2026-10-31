---
name: opencode-result-handling
description: Guidance for interpreting and presenting OpenCode task results, plus how to poll live progress of a running background task
user-invocable: false
metadata:
  version: "1.3.1"
---

# OpenCode Result Handling

Read the final JSON digest only: `status`, `filesChanged`, `commandsRun`
(command + actual exitCode), `testsSummary`, `failures` (at most 40 verbatim
lines), `logPath`, `worktreePath`, and `configChanges` including backup paths.
An unknown tool exitCode stays null; never claim its command passed.

Return the digest verbatim. Full transcripts remain in `logPath`; open them
only for an explicit investigation. `status <job-id> --json` is local metadata
only: `running|done|failed`, PID, agent PID and last output timestamp. Poll it
with short calls. Use `result <job-id>` once terminal. Do not tail logs or
repeatedly fetch full session messages. `--resume-last` continues the most
recent task session in the same Claude session; `--fresh` starts another.

---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
metadata:
  version: "1.3.1"
---

# OpenCode Runtime

Dispatch one job, poll metadata, return one digest. Do not solve the delegated
request or inspect its full logs unless the user asks for investigation.

Use a quoted stdin heredoc with a unique delimiter absent from raw arguments:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --background --arguments-stdin <<'OC_ARGS_7db82a'
$ARGUMENTS
OC_ARGS_7db82a
```

A JSON argv array on stdin preserves literal quotes, newlines and empty strings.
Never interpolate the prompt or raw slash arguments into shell command text.
A prompt file passed through `--prompt-file` is another safe option.

Read `jobId` from launch JSON. Poll `status <job-id> --json` using short calls;
`.job.status` is `running`, `done`, or `failed`. Each status includes PID and
`lastOutputAt`, with no log output. Once terminal, call `result <job-id>` once
and return its JSON verbatim. Do not use tail -f or load the full transcript.

Pass explicit `--model provider/model#variant`, `--agent`, `--full-access`,
`--no-full-access`, `--no-repair-config`, `--standalone`, `--worktree <branch>`
and `--incident-log <path>` through as data. Full access defaults off unless
chosen via setup userConfig `full_access`; never add it without authorization.
Use `--read-only` for investigation-only requests. Map `--resume` to
`--resume-last`; `--fresh` starts a new session. Leave model unset unless chosen.

# OpenCode plugin for Claude Code

> **Tribute**: This project is inspired by and pays homage to
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) by OpenAI.
> The plugin architecture, command structure, and design patterns are derived from
> the original codex-plugin-cc project, adapted to work with
> [OpenCode](https://github.com/anomalyco/opencode) instead of Codex.

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

## Install

Requires Claude Code, Node.js 24 on Windows, and an authenticated OpenCode CLI.
OpenCode 1 and 2 transports are supported; the real Windows smoke uses v2.1.4.

```bash
npm install -g @opencode/cli
```

Inside Claude Code:

```text
! curl -fsSL https://raw.githubusercontent.com/NguyenCong2k/opencode-plugin-cc/main/install.sh | bash
/reload-plugins
/opencode:setup
```

Authenticate with `opencode auth login`; inspect credentials with `opencode auth
list` and available models with `opencode models`. Setup falls back to those CLI
commands when no HTTP service is available. An absent service does not imply
missing provider credentials.

## Delegate

```text
/opencode:rescue --full-access --worktree feature/hello --model opencode-go/deepseek-v4.1-flash#max create hello.txt and run git status
```

All task and review jobs return a compact JSON digest. Background launches
return `jobId`, PID and log path. `status <job-id> --json` reads local metadata
only: `running|done|failed`, PID, agent PID and `lastOutputAt`. `result <job-id>`
returns the saved digest. Full transcripts stay in `logPath`.

For human-readable output, use `review --text`, `adversarial-review --text`, or
`status [job-id] --text`. JSON remains the default; `--json` takes precedence.
Review digests retain up to 8,000 characters in `reviewOutput`, with
`reviewOutputTruncated` indicating whether the full log contains more.

| Command | Purpose |
| --- | --- |
| `/opencode:rescue` | Delegate work through the thin forwarder |
| `/opencode:review` | Read-only code review |
| `/opencode:adversarial-review` | Focused adversarial review |
| `/opencode:status` | Cheap local job metadata |
| `/opencode:result` | Final JSON digest |
| `/opencode:cancel` | Stop an owned process tree and save a failure digest |
| `/opencode:setup` | Provider discovery and userConfig choices |

## Access and configuration

Full access defaults off. Opt in per job with `--full-access`, or persist a
workspace userConfig choice with `/opencode:setup --full-access true`. Persisted
settings are `full_access` and `repair_config` in companion workspace state.
`--no-full-access` overrides the saved choice for one job.

OpenCode 2 full access uses a private `run --standalone --auto` process after
checking CLI capabilities, effective config sources and the selected agent.
Required tool deny rules or tool policies cause a startup error; policy changes
or denials during execution produce a blocked digest. The host user supplies
filesystem, loopback/network and process authority. OS and managed policy
restrictions cannot be bypassed. No permission mode is silently downgraded.
Normal v2 jobs use the managed service unless `--standalone` is chosen. HTTP
clients discover service registration, `OPENCODE_SERVER_URL`, configured
`server.port`, or `OPENCODE_SERVER_PORT`; there is no fixed service port.

OpenCode 1 full access supports the build agent and sets job-local
`OPENCODE_PERMISSION`. Legacy global permission repair remains available only
when explicitly using full access (or `doctor --fix`). It backs up existing
config bytes first, preserves unrelated keys and reports changes plus backup
paths in `configChanges`. Disable it with `--no-repair-config`, or persist
`/opencode:setup --repair-config false`. Malformed JSON is rejected, preserved
and never replaced with a blank config.

`--worktree <branch>` creates an isolated Git worktree, using an existing branch
when available. Worktrees remain for review and manual merge/removal. The default
root is the OS temp directory under `opencode-worktrees`; override with
`OPENCODE_WORKTREE_ROOT`. Keeping this root short avoids Git for Windows path
limits. Jobs normalize logical PWD to the worktree. Clean worktrees are removed
after completion, startup failure, or cancellation. Dirty worktrees retain all
output and are reused by the next job requesting that branch; active jobs cannot
share one. If Git refuses cleanup, the worktree is also retained for reuse.
The digest reports `worktreeStatus` (`removed` or `retained`).

`--incident-log <path>` or `OPENCODE_INCIDENT_LOG` appends UTC Markdown entries
for failures, blocked requests, timeouts and owned process termination.
`--timeout-ms <number>` limits the agent run. Provider and permission probes
also have deadlines. Cancellation does not stop a shared service.

## Automation contract

Pass arbitrary text through `--prompt-file` or `--arguments-stdin`. Stdin accepts
a JSON argv array, preserving literal quotes, newlines and Unicode. Slash
commands use a quoted heredoc with a unique delimiter absent from the data;
never interpolate raw user text into shell command strings. Windows npm
launchers resolve to a native executable or Node entry point with `shell:false`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --background --arguments-stdin <<'OC_ARGS_7db82a'
["--full-access", "--worktree", "feature/hello", "create hello.txt and run git status"]
OC_ARGS_7db82a
```

Digest fields: `status` (`passed|failed|blocked|error`), `filesChanged`,
`commandsRun` (command and actual exit code), `testsSummary`, `failures`
(at most 40 verbatim lines), `logPath`, `worktreePath`, `configChanges`.
Unknown tool exit codes remain null. Changed files combine Git observations
with successful write/edit tool events, including external paths.

`provider/model#variant` is preserved in foreground and background jobs. Model
existence is checked before inference. Budget/quota failures retain the original
error and suggest another discovered provider for the same model when available.

Use `heal` explicitly for legacy HTTP jobs; status polling never fetches logs.
`wait-and-result` supports older automation and returns the same saved digest.

## Development

Run `npm test` in PowerShell and Git Bash. Tests include Windows metacharacters,
Vietnamese paths, provider fallback, v1/v2 HTTP compatibility, model routing,
full-access policy checks, backups, worktrees, concurrent state updates,
background status/results, cancellation, incident recording and bounded digests.

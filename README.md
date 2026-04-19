# OpenCode plugin for Claude Code

> **Tribute**: This project is inspired by and pays homage to
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) by OpenAI.
> The plugin architecture, command structure, and design patterns are derived from
> the original codex-plugin-cc project, adapted to work with
> [OpenCode](https://github.com/anomalyco/opencode) instead of Codex.

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

## Quickstart

```bash
# 1. Install opencode (once)
npm i -g opencode-ai   # or: brew install opencode

# 2. Install the plugin (see Install section below)

# 3. Run the self-test — fixes common footguns for you
node ~/.claude/plugins/cache/tasict-opencode-plugin-cc/opencode/1.0.0/scripts/opencode-companion.mjs doctor --fix
```

Then delegate a task from Claude Code:

```
/opencode:rescue grep for XXX in src/ and summarize
```

`doctor --fix` writes the correct `~/.config/opencode/opencode.json` permissions so the
bash tool does not hang in headless mode (sst/opencode#14473). This is the single biggest
footgun for newcomers — `ensureServer` will also run this fix automatically on first use.

## What You Get

- `/opencode:review` for a normal read-only OpenCode review
- `/opencode:adversarial-review` for a steerable challenge review
- `/opencode:rescue`, `/opencode:status`, `/opencode:result`, and `/opencode:cancel` to delegate work and manage background jobs

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension)
- [OpenCode](https://github.com/anomalyco/opencode) installed (`npm i -g opencode-ai` or `brew install opencode`)
- A configured AI provider in OpenCode (Claude, OpenAI, Google, etc.)
- Node.js 18.18 or later

## Install

Inside Claude Code, run:

```
! curl -fsSL https://raw.githubusercontent.com/tasict/opencode-plugin-cc/main/install.sh | bash
```

Then reload the plugin:

```
/reload-plugins
```

You should see:

```
Reloaded: 1 plugin · 7 skills · 6 agents · 3 hooks ...
```

Finally, verify your setup:

```
/opencode:setup
```

> **What the installer does**: Clones the repo to `~/.claude/plugins/marketplaces/`,
> caches the plugin files, and registers it in Claude Code's plugin config.
> It tries SSH first and falls back to HTTPS automatically.

### Set up an AI Provider

If OpenCode is installed but no AI provider is configured, set one up:

```
! opencode providers login
```

To check your configured providers:

```
! opencode providers list
```

### Uninstall

```
/plugin uninstall opencode@tasict-opencode-plugin-cc
/reload-plugins
```

## Command Mapping (codex-plugin-cc -> opencode-plugin-cc)

| codex-plugin-cc | opencode-plugin-cc | Description |
|---|---|---|
| `/codex:review` | `/opencode:review` | Read-only code review |
| `/codex:adversarial-review` | `/opencode:adversarial-review` | Adversarial challenge review |
| `/codex:rescue` | `/opencode:rescue` | Delegate tasks to external agent |
| `/codex:status` | `/opencode:status` | Show running/recent jobs |
| `/codex:result` | `/opencode:result` | Show finished job output |
| `/codex:cancel` | `/opencode:cancel` | Cancel active background job |
| `/codex:setup` | `/opencode:setup` | Check install/auth, toggle review gate |

## Slash Commands

- `/opencode:review` -- Normal OpenCode code review (read-only). Supports `--base <ref>`, `--wait`, `--background`.
- `/opencode:adversarial-review` -- Steerable review that challenges implementation and design decisions. Accepts custom focus text.
- `/opencode:rescue` -- Delegates a task to OpenCode via the `opencode:opencode-rescue` subagent. Supports `--model`, `--agent`, `--resume`, `--fresh`, `--background`.
- `/opencode:status` -- Shows running/recent OpenCode jobs for the current repo.
- `/opencode:result` -- Shows final output for a finished job, including OpenCode session ID for resuming.
- `/opencode:cancel` -- Cancels an active background OpenCode job.
- `/opencode:setup` -- Checks OpenCode install/auth, can enable/disable the review gate hook.

## Review Gate

When enabled via `/opencode:setup --enable-review-gate`, a Stop hook runs a targeted OpenCode review on Claude's response. If issues are found, the stop is blocked so Claude can address them first. Warning: can create long-running loops and drain usage limits.

## Job Auto-Heal

Long-running tasks spawned via `/opencode:task --background` occasionally get
stuck in `investigating` status even after the OpenCode session has finished
server-side — typically because `POST /session/:id/message` fails to close its
HTTP body, the task-worker is killed, or the companion's watcher misses the
terminal signal.

The companion now reconciles this automatically:

- `companion.mjs status` and `companion.mjs result` run a silent auto-heal
  pass before they read state, so they never report a false "running" state
  for a session that is actually complete.
- `companion.mjs heal` scans for stuck jobs and reconciles them in bulk. Pass
  `--dry-run` to preview, `--json` for machine-readable output, and `--all`
  to include jobs from other Claude sessions.

Each heal check queries `GET /session/:id/message?limit=1`. If the last
assistant message has `info.finish` set and `info.time.completed >= job.startedAt`,
the job is transitioned to `completed` and the message text is persisted to
the job data file. If the task-worker PID is dead and the session has been
silent for >60 s, the job is transitioned to `failed` with a clear reason.

If the OpenCode server is unreachable, auto-heal is a no-op — status/result
commands still work, they just can't move stuck jobs forward until the server
comes back.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_REQUEST_TIMEOUT_MS` | `1800000` | Per-HTTP-request abort timeout |
| `OPENCODE_PROMPT_TIMEOUT_MS` | `14400000` | `sendPrompt` absolute cap (races the 5-min server body-close) |
| `OPENCODE_IDLE_TIMEOUT_MS` | `900000` | Session idle watchdog — no activity for this long → abort |
| `OPENCODE_PGREP_MISS_THRESHOLD` | `3` | Consecutive pgrep-misses before declaring a stuck bash tool |
| `OPENCODE_COMPLETION_POLL_MS` | `5000` | Watcher poll interval during `sendPrompt` |
| `OPENCODE_COMPANION_DATA` | (self-derived) | Override for plugin data dir (otherwise derived from script path) |
| `OPENCODE_MONITOR_RESULT_CHARS` | (hook default) | Monitor hook: max chars per tool-result snippet |
| `OPENCODE_MONITOR_HEARTBEAT_POLLS` | (hook default) | Monitor hook: polls between heartbeats |
| `OPENCODE_SERVER_PASSWORD` | (unset) | HTTP Basic auth password for `opencode serve` |
| `OPENCODE_SERVER_USERNAME` | `opencode` | HTTP Basic auth username |

Run `companion.mjs config` to see resolved values with source (env vs default).

## Pitfalls

- **`companion status` stuck on `investigating`** — run `companion heal` (or wait; `status`/`result` auto-heal on every call).
- **Bash tool hangs for minutes** — run `companion doctor --fix` to merge the required `permission.*=allow` keys into `~/.config/opencode/opencode.json`. This is sst/opencode#14473 in headless mode.
- **`CLAUDE_PLUGIN_DATA` points at another plugin** — harmless: the companion self-derives its own data dir from `import.meta.url`. `doctor` will print a WARN so you know.

## Troubleshooting

<details>
<summary><strong>Plugin not loading after install (0 plugins)</strong></summary>

1. Re-run the installer: `! curl -fsSL https://raw.githubusercontent.com/tasict/opencode-plugin-cc/main/install.sh | bash`
2. Run `/reload-plugins` again.
3. If still failing, restart Claude Code.
</details>

<details>
<summary><strong>Install script fails to clone</strong></summary>

The script tries SSH first, then HTTPS. If both fail:

- Check your network connection
- For SSH: ensure `ssh -T git@github.com` works
- For HTTPS: run `gh auth login` to set up credentials
</details>

<details>
<summary><strong>OpenCode commands not working</strong></summary>

1. Verify OpenCode is installed: `! opencode --version`
2. Verify a provider is configured: `! opencode providers list`
3. Run `/opencode:setup` to check the full status.
</details>

## Architecture

Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout, this plugin communicates with
OpenCode via its HTTP REST API + Server-Sent Events (SSE) for streaming. The server is automatically
started and managed by the companion scripts.

```
codex-plugin-cc                          opencode-plugin-cc
+----------------------+                 +------------------------+
| JSON-RPC over stdio  |                 | HTTP REST + SSE        |
| codex app-server     |      vs.        | opencode serve         |
| Broker multiplexing  |                 | Native HTTP (no broker)|
| codex CLI binary     |                 | opencode CLI binary    |
+----------------------+                 +------------------------+
```

## Project Structure

```
opencode-plugin-cc/
├── .claude-plugin/marketplace.json       # Marketplace registration
├── install.sh                            # One-line installer
├── plugins/opencode/
│   ├── .claude-plugin/plugin.json        # Plugin metadata
│   ├── agents/opencode-rescue.md         # Rescue subagent definition
│   ├── commands/                         # 7 slash commands
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   ├── rescue.md
│   │   ├── status.md
│   │   ├── result.md
│   │   ├── cancel.md
│   │   └── setup.md
│   ├── hooks/hooks.json                  # Lifecycle hooks
│   ├── prompts/                          # Prompt templates
│   ├── schemas/                          # Output schemas
│   ├── scripts/                          # Node.js runtime
│   │   ├── opencode-companion.mjs        # CLI entry point
│   │   ├── session-lifecycle-hook.mjs
│   │   ├── stop-review-gate-hook.mjs
│   │   └── lib/                          # Core modules
│   │       ├── opencode-server.mjs       # HTTP API client
│   │       ├── state.mjs                 # Persistent state
│   │       ├── job-control.mjs           # Job management
│   │       ├── tracked-jobs.mjs          # Job lifecycle tracking
│   │       ├── render.mjs               # Output rendering
│   │       ├── prompts.mjs              # Prompt construction
│   │       ├── git.mjs                  # Git utilities
│   │       ├── process.mjs             # Process utilities
│   │       ├── args.mjs                # Argument parsing
│   │       ├── fs.mjs                  # Filesystem utilities
│   │       └── workspace.mjs           # Workspace detection
│   └── skills/                          # Internal skills
├── tests/                               # Test suite
├── LICENSE                              # Apache License 2.0
├── NOTICE                               # Attribution notice
└── README.md
```

## OpenCode Integration

Wraps the OpenCode HTTP server API. Picks up config from:
- User-level: `~/.config/opencode/config.json`
- Project-level: `.opencode/opencode.jsonc`

## License

Copyright 2026 OpenCode Plugin Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

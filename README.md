# OpenCode plugin for Claude Code

> **Tribute**: This project is inspired by and pays homage to
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) by OpenAI.
> The plugin architecture, command structure, and design patterns are derived from
> the original codex-plugin-cc project, adapted to work with
> [OpenCode](https://github.com/anomalyco/opencode) instead of Codex.

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

## What You Get

- `/opencode:review` for a normal read-only OpenCode review
- `/opencode:adversarial-review` for a steerable challenge review
- `/opencode:rescue`, `/opencode:status`, `/opencode:result`, and `/opencode:cancel` to delegate work and manage background jobs

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

## Requirements

- OpenCode installed (`npm i -g opencode-ai` or `brew install opencode`)
- A configured AI provider (Claude, OpenAI, Google, etc.)
- Node.js 18.18 or later

## Install

```
/plugin marketplace add opencode-ai/opencode-plugin-cc
/plugin install opencode@opencode-ai
/reload-plugins
/opencode:setup
```

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

## OpenCode Integration

Wraps the OpenCode HTTP server API. Picks up config from:
- User-level: `~/.config/opencode/config.json`
- Project-level: `.opencode/opencode.jsonc`

## Architecture

Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout, this plugin communicates with
OpenCode via its HTTP REST API + Server-Sent Events (SSE) for streaming. The server is automatically
started and managed by the companion scripts.

```
codex-plugin-cc                          opencode-plugin-cc
┌──────────────────────┐                 ┌──────────────────────┐
│ JSON-RPC over stdio  │                 │ HTTP REST + SSE      │
│ codex app-server     │      vs.        │ opencode serve       │
│ Broker multiplexing  │                 │ Native HTTP (no broker)│
│ codex CLI binary     │                 │ opencode CLI binary   │
└──────────────────────┘                 └──────────────────────┘
```

## Project Structure

```
opencode-plugin-cc/
├── .claude-plugin/marketplace.json       # Marketplace registration
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

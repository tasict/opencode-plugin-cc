---
description: Check whether the local OpenCode CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), Bash(curl:*), AskUserQuestion
---

Pass slash arguments as data through a quoted stdin heredoc. Choose a unique
heredoc delimiter absent from the argument text (replace the sample delimiter
below when necessary). Never put raw arguments in a shell command, a template
literal, or an unquoted heredoc. The companion also accepts a JSON argv array.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --json --arguments-stdin <<'OPENCODE_ARGS_7db82a'
$ARGUMENTS
OPENCODE_ARGS_7db82a
```

Return stdout verbatim. Job results are compact JSON digests; do not read the
full log unless the user requests investigation. `--background` detaches jobs;
poll `status <job-id> --json`, then call `result <job-id>` once terminal.

If CLI is missing, offer installation once. If providers need authentication,
use `opencode auth login`, then `opencode models`. No server does not mean no credentials.

---
description: Show running and recent OpenCode jobs for the current repository
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Pass slash arguments as data through a quoted stdin heredoc. Choose a unique
heredoc delimiter absent from the argument text (replace the sample delimiter
below when necessary). Never put raw arguments in a shell command, a template
literal, or an unquoted heredoc. The companion also accepts a JSON argv array.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status --arguments-stdin <<'OPENCODE_ARGS_7db82a'
$ARGUMENTS
OPENCODE_ARGS_7db82a
```

Return stdout verbatim. Job results are compact JSON digests; do not read the
full log unless the user requests investigation. `--background` detaches jobs;
poll `status <job-id> --json`, then call `result <job-id>` once terminal.

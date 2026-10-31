---
description: Run a steerable adversarial OpenCode review that challenges implementation and design decisions
argument-hint: '[--wait|--background] [--base <ref>] [focus area or custom review instructions]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Pass slash arguments as data through a quoted stdin heredoc. Choose a unique
heredoc delimiter absent from the argument text (replace the sample delimiter
below when necessary). Never put raw arguments in a shell command, a template
literal, or an unquoted heredoc. The companion also accepts a JSON argv array.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" adversarial-review --arguments-stdin <<'OPENCODE_ARGS_7db82a'
$ARGUMENTS
OPENCODE_ARGS_7db82a
```

Return stdout verbatim. Job results are compact JSON digests; do not read the
full log unless the user requests investigation. `--background` detaches jobs;
poll `status <job-id> --json`, then call `result <job-id>` once terminal.

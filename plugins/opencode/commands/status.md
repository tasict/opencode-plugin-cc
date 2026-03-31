---
description: Show running and recent OpenCode jobs for the current repository
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the status command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.

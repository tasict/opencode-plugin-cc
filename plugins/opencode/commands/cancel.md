---
description: Cancel an active background OpenCode job
argument-hint: '[job-id-prefix]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the cancel command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cancel $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.

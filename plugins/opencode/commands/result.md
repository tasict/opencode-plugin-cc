---
description: Show final output for a finished OpenCode job, including session ID for resuming
argument-hint: '[job-id-prefix]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the result command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the result output.

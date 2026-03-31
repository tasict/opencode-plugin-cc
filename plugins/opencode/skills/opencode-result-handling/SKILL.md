---
name: opencode-result-handling
description: Guidance for interpreting and presenting OpenCode task results
user-invocable: false
---

# OpenCode Result Handling

## Result Structure

OpenCode returns results as structured session data containing:
- **Messages**: The full conversation between the user prompt and OpenCode's agent
- **Tool calls**: All tool invocations (bash, edit, read, write, grep, glob, etc.)
- **File changes**: Diffs of all files modified during the session
- **Status**: Whether the session completed successfully, was aborted, or errored

## Presenting Results

When displaying results from `/opencode:result`:
1. Show the session ID for reference
2. Present the final assistant message as the primary output
3. If file changes were made, summarize which files were modified
4. Include the session status (completed/aborted/error)

## Resuming Sessions

OpenCode sessions can be resumed by sending additional messages to the same session.
The `--resume-last` flag in the companion script handles this by reusing the last session ID
from the current workspace state.

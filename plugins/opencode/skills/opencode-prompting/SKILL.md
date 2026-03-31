---
name: opencode-prompting
description: Best practices for crafting effective prompts when delegating tasks to OpenCode
user-invocable: false
---

# OpenCode Prompting Guide

Use this skill to shape prompts before forwarding to the OpenCode companion runtime.

## Prompt Structure

A good OpenCode task prompt should:
1. **State the goal clearly** -- What should be accomplished?
2. **Provide context** -- What files, functions, or systems are involved?
3. **Define success criteria** -- How do we know it's done?
4. **Set constraints** -- What should NOT be changed?

## Agent Selection

OpenCode has two primary agents:
- **build** (default): Full read/write access, can execute commands, edit files, and make changes
- **plan**: Read-only analysis mode, good for investigation and architecture planning

## Best Practices

- Be specific about file paths and function names when possible
- Include error messages or test failures verbatim
- Specify the programming language and framework context
- If debugging, include reproduction steps
- For refactoring, describe the desired end state

## Anti-patterns

- Do not ask OpenCode to "fix everything" without specifics
- Do not include irrelevant context that dilutes the prompt
- Do not ask for multiple unrelated tasks in one prompt
- Do not assume OpenCode knows your project's conventions without telling it

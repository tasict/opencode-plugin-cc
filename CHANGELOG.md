# Changelog

## 1.3.1 - 2026-10-27

- Resolve standard npm Windows shims using their executed target.
- Select build for full-access review defaults; preserve explicit agent choices.
- Retain bounded assistant review output in digests and expose optional text modes.
- Preserve contractions and task flags, including an end-of-options delimiter.
- Remove clean worktrees and reuse retained output without sharing active jobs.
- Normalize Windows workspace keys for state and worktrees.
- Consolidate incident traces, omit harness probes from command digests, and
  classify blocked jobs using specific permission denial phrases.
- Cover standard npm launcher guards in unit and integration fixtures.

## 1.3.0 ? 2026-10-27

- Resolve Windows npm launchers without a shell and preserve Unicode PATH/PWD.
- Discover configured/managed service ports and fall back to CLI auth/models.
- Support OpenCode 1 and 2, including v2 service and private standalone runs.
- Validate provider/model#variant before inference and retain provider errors.
- Add explicit full-access choices with capability/policy preflight checks.
- Back up legacy permission repairs, report changes, and support opt-out.
- Save compact JSON digests and full logs for foreground/background jobs.
- Add cheap local status, isolated worktrees, concurrent state locking and
  incident logging for failures, blocked requests, timeouts and process kills.
- Transport slash arguments/prompts through stdin/files and update forwarding
  skills/hooks to follow the digest contract.

## 1.2.0

- Existing OpenCode companion, review, rescue, state and API compatibility.

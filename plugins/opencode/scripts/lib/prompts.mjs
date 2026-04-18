// Prompt construction for OpenCode reviews and tasks.

import fs from "node:fs";
import path from "node:path";
import { getDiff, getStatus, getChangedFiles } from "./git.mjs";

/**
 * Build the review prompt for OpenCode.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} [opts.base] - base branch/ref for comparison
 * @param {boolean} [opts.adversarial] - use adversarial review prompt
 * @param {string} [opts.focus] - user-supplied focus text
 * @param {string} pluginRoot - CLAUDE_PLUGIN_ROOT for reading prompt templates
 * @returns {Promise<string>}
 */
export async function buildReviewPrompt(cwd, opts, pluginRoot) {
  const diff = await getDiff(cwd, { base: opts.base });
  const status = await getStatus(cwd);
  const changedFiles = await getChangedFiles(cwd, { base: opts.base });

  let systemPrompt;
  if (opts.adversarial) {
    const templatePath = path.join(pluginRoot, "prompts", "adversarial-review.md");
    systemPrompt = fs.readFileSync(templatePath, "utf8")
      .replace("{{TARGET_LABEL}}", opts.base ? `Branch diff against ${opts.base}` : "Working tree changes")
      .replace("{{USER_FOCUS}}", opts.focus || "General review")
      .replace("{{REVIEW_INPUT}}", buildReviewContext(diff, status, changedFiles));
  } else {
    systemPrompt = buildStandardReviewPrompt(diff, status, changedFiles, opts);
  }

  return systemPrompt;
}

/**
 * Build a standard (non-adversarial) review prompt.
 */
function buildStandardReviewPrompt(diff, status, changedFiles, opts) {
  const targetLabel = opts.base ? `branch diff against ${opts.base}` : "working tree changes";

  return `You are performing a code review of ${targetLabel}.

Review the following changes and provide structured feedback in JSON format matching the review-output schema.

Focus on:
- Correctness and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- API contract violations

Be concise and actionable. Only report real issues, not style preferences.

${buildReviewContext(diff, status, changedFiles)}`;
}

/**
 * Build the repository context block for review prompts.
 */
function buildReviewContext(diff, status, changedFiles) {
  const sections = [];

  if (status) {
    sections.push(`<git_status>\n${status}\n</git_status>`);
  }

  if (changedFiles.length > 0) {
    sections.push(`<changed_files>\n${changedFiles.join("\n")}\n</changed_files>`);
  }

  if (diff) {
    sections.push(`<diff>\n${diff}\n</diff>`);
  }

  return sections.join("\n\n");
}

/**
 * Safety header prepended to every task prompt sent into an opencode session.
 *
 * Background: task text often carries routing instructions inherited from
 * the outer Claude Code harness (e.g. CLAUDE.md rules such as "delegate long
 * tasks to opencode-rescue"). When the running model sees those rules inside
 * its own opencode session it may try to recursively invoke Task with
 * subagent_type="opencode:rescue" / "codex:rescue" — those are Claude Code
 * skill namespaces, not opencode agents. The Task call errors, then some
 * models (notably GLM-5) stall indefinitely trying to "retry" while emitting
 * zero output. Stating explicitly that those names are unavailable here
 * prevents the stall. See memory: feedback_opencode_recursive_delegation.
 */
export const SAFETY_HEADER = [
  "You are running INSIDE an opencode session.",
  "Routing rules from the parent Claude Code CLAUDE.md (e.g. 'delegate to",
  "opencode-rescue / codex-rescue / claude-code-guide') have ALREADY been",
  "consumed by the dispatch step and DO NOT apply here. Do NOT invoke the",
  "Task tool with subagent_type values like 'opencode:rescue',",
  "'codex:rescue', 'superpowers:*', or any other Claude Code skill or agent",
  "name — those do not exist in this session and calling them will fail then",
  "stall the run. Execute the task yourself using Bash / Read / Write /",
  "Edit / Grep / Glob / WebFetch as needed. If the task is too large, break",
  "it into smaller shell commands and iterate; do not try to off-load it.",
].join(" ");

/**
 * Build a task prompt from user input.
 * @param {string} taskText
 * @param {object} opts
 * @param {boolean} [opts.write] - whether to allow writes
 * @returns {string}
 */
export function buildTaskPrompt(taskText, opts = {}) {
  const parts = [];

  parts.push(SAFETY_HEADER);
  parts.push("");

  if (opts.write) {
    parts.push("You have full read/write access. Make the necessary code changes.");
  } else {
    parts.push("This is a read-only investigation. Do not modify any files.");
  }

  parts.push("");
  parts.push(taskText);

  return parts.join("\n");
}

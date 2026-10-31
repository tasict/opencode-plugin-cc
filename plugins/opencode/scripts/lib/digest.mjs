import { isBlockedFailure } from "./incidents.mjs";

export function collectTelemetry(value) {
  const commands = [], failures = [], tests = [], files = [];
  const seen = new Set();
  let blocked = false;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    const state = node.state ?? node;
    const command = state.input?.command ?? node.input?.command;
    const tool = node.tool ?? node.name ?? node.type;
    if (/^(?:write|edit|patch|apply_patch)$/.test(tool || "") && state.status === "completed") {
      const file = state.input?.filePath ?? state.input?.file_path ?? state.input?.path;
      if (typeof file === "string") files.push(file);
    }
    if (typeof command === "string" && /bash|shell|tool/.test(tool || "")) {
      const code = state.metadata?.metadata?.exit ?? state.metadata?.exit ?? state.metadata?.exitCode ?? state.exitCode ?? node.exitCode;
      const exitCode = Number.isInteger(code) ? code : state.status === "error" ? 1 : null;
      const key = node.id ?? `${command}:${exitCode}`;
      if (!seen.has(key)) {
        seen.add(key); commands.push({ command, exitCode });
        if (/\b(test|pytest|vitest|jest|ctest|dotnet test)\b/.test(command)) tests.push({ command, exitCode });
        if (exitCode !== null && exitCode !== 0 && state.output) failures.push(...String(state.output).split(/\r?\n/));
      }
    }
    const error = state.error ?? (node.type === "error" ? node.error ?? node.message : null);
    if (error) {
      const text = typeof error === "string" ? error : error.message ?? JSON.stringify(error);
      failures.push(...text.split(/\r?\n/));
      if (isBlockedFailure(text)) blocked = true;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "input" || key === "metadata") continue;
      if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === "object") visit(child);
    }
  }
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) { try { visit(JSON.parse(line)); } catch {} }
  } else visit(value);
  return { commands, failures: failures.slice(0, 40), tests, blocked, files: [...new Set(files)] };
}

function assistantText(value) {
  const texts = [];
  function visit(node) {
    if (!node || typeof node !== "object" || node.role === "user") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === "text" && typeof node.text === "string") { texts.push(node.text); return; }
    for (const key of ["part", "parts", "messages", "content"]) visit(node[key]);
  }
  if (typeof value === "string") {
    for (const line of value.split(/\r?\n/)) { try { visit(JSON.parse(line)); } catch {} }
  } else visit(value);
  return texts.join("\n");
}

export function makeDigest({ result = {}, error, logPath, worktreePath, worktreeStatus, configChanges = [], jobType }) {
  error ??= result.error ? new Error(result.error) : undefined;
  const telemetry = collectTelemetry(result.messages ?? result.raw ?? "");
  const failures = [...telemetry.failures, ...(error ? String(error.message ?? error).split(/\r?\n/) : [])].slice(0, 40);
  const blocked = telemetry.blocked || isBlockedFailure(error?.message ?? "");
  const failedCommand = telemetry.commands.some((c) => c.exitCode !== null && c.exitCode !== 0);
  const review = ["review", "adversarial-review"].includes(jobType)
    ? assistantText(result.messages ?? result.raw) || result.rendered || "" : null;
  return {
    status: blocked ? "blocked" : error && result.exitCode === undefined ? "error" : error || failures.length || failedCommand ? "failed" : "passed",
    filesChanged: result.changedFiles ?? [],
    commandsRun: telemetry.commands,
    testsSummary: result.testsSummary ?? { observed: telemetry.tests.length, passed: telemetry.tests.filter((t) => t.exitCode === 0).length,
      failed: telemetry.tests.filter((t) => t.exitCode !== null && t.exitCode !== 0).length,
      unknown: telemetry.tests.filter((t) => t.exitCode === null).length },
    failures, logPath, worktreePath: worktreePath ?? null, configChanges,
    ...(worktreeStatus ? { worktreeStatus } : {}),
    ...(review !== null ? { reviewOutput: review.slice(0, 8000), reviewOutputTruncated: review.length > 8000 } : {}),
  };
}

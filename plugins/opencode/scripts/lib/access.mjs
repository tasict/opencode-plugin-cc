import { ensureOpencodeConfig } from "./opencode-config.mjs";
import { runCommand } from "./process.mjs";

const REQUIRED = new Set(["*", "shell", "bash", "edit", "read", "webfetch", "external_directory"]);

export function assertFullAccessPolicy(documents, agents, agentName) {
  const selected = agents.find((agent) => (agent.id ?? agent.name) === agentName);
  if (!selected) throw new Error(`Full access unavailable: agent ${agentName} was not found`);
  for (const doc of documents) {
    const info = doc.info ?? {};
    const policies = [...(info.policies ?? []), ...(info.experimental?.policies ?? [])];
    if (policies.some((p) => p.effect === "deny" && ["tool.use", "permission"].includes(p.action))) {
      throw new Error(`Full access blocked by configuration policy: ${doc.path ?? doc.type}`);
    }
    const rules = info.permissions ?? [];
    if (rules.some((r) => REQUIRED.has(r.action) && r.effect === "deny")) throw new Error(`Full access blocked by deny rule in ${doc.path ?? doc.type}`);
  }
  if ((selected.permissions ?? []).some((rule) => REQUIRED.has(rule.action) && rule.effect === "deny")) {
    throw new Error(`Full access blocked by agent ${agentName} permission deny`);
  }
}

export async function prepareAccess({ fullAccess, repairConfig = true, major, cwd, agent = "build", run = runCommand }) {
  if (!fullAccess) return { flags: [], env: {}, configChanges: [] };
  if (major >= 2) {
    const help = await run("opencode", ["run", "--help"], { cwd, timeoutMs: 15_000 });
    if (!/--auto\b/.test(help.stdout) || !/--standalone\b/.test(help.stdout)) throw new Error("Installed OpenCode does not support full access (--auto/--standalone)");
    const config = await run("opencode", ["debug", "config"], { cwd, timeoutMs: 15_000 });
    const agents = await run("opencode", ["debug", "agents"], { cwd, timeoutMs: 15_000 });
    if (config.exitCode !== 0 || agents.exitCode !== 0) throw new Error("Cannot verify OpenCode full-access policy before startup");
    assertFullAccessPolicy(JSON.parse(config.stdout), JSON.parse(agents.stdout), agent);
    return { flags: ["--auto"], env: {}, configChanges: [], mode: "auto-approve; host filesystem, network and processes" };
  }
  if (major !== 1) throw new Error(`Unsupported OpenCode major version: ${major}`);
  if (agent !== "build") throw new Error(`Full access cannot be verified for OpenCode 1 agent ${agent}; use build`);
  const repair = ensureOpencodeConfig({ enabled: repairConfig, silent: true });
  return { flags: [], env: { OPENCODE_PERMISSION: JSON.stringify({ "*": "allow" }) },
    configChanges: repair.changed ? [repair] : [], mode: "OPENCODE_PERMISSION=* allow" };
}

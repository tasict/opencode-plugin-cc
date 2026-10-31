// Self-heal for ~/.config/opencode/opencode.json permissions.
//
// Background: opencode's bash tool hangs forever in headless mode when
//   permission.external_directory == "ask" (sst/opencode#14473).
// Legacy OpenCode 1 runs `opencode serve` in headless mode, so it MUST have:
//   permission.bash             = "allow"
//   permission.edit             = "allow"
//   permission.webfetch         = "allow"
//   permission.external_directory = "allow"
//
// ensureOpencodeConfig() merges these in idempotently, preserving any other
// user keys. OpenCode 2 owns permission policy and this repair is not applied.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDir } from "./fs.mjs";

export const REQUIRED_PERMISSIONS = {
  bash: "allow",
  edit: "allow",
  webfetch: "allow",
  external_directory: "allow",
};

/**
 * Resolve the opencode config file path, respecting $XDG_CONFIG_HOME.
 * @returns {string}
 */
export function resolveConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "opencode.json");
}

/**
 * Read the opencode config, returning the parsed object or a fresh scaffold.
 * @returns {{ path: string, exists: boolean, data: object }}
 */
export function readOpencodeConfig() {
  const p = resolveConfigPath();
  const exists = fs.existsSync(p);
  const data = exists ? JSON.parse(fs.readFileSync(p, "utf8")) : { $schema: "https://opencode.ai/config.json" };
  return { path: p, exists, data };
}

/**
 * Returns the set of permission keys that are NOT already "allow".
 * @param {object} data
 * @returns {string[]}
 */
export function missingPermissions(data) {
  const perm = (data && data.permission) || {};
  if (perm === "allow") return [];
  const missing = [];
  for (const [k, v] of Object.entries(REQUIRED_PERMISSIONS)) {
    if (perm[k] !== v) missing.push(k);
  }
  return missing;
}

/**
 * Ensure opencode.json has all required permissions set to "allow".
 * Idempotent: if everything is already correct, does not touch the file.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - if true, do not write; just report what would change
 * @param {boolean} [opts.silent] - if true, suppress stderr notice on change
 * @returns {{ path: string, changed: boolean, missing: string[], dryRun: boolean }}
 */
export function ensureOpencodeConfig(opts = {}) {
  const dryRun = !!opts.dryRun;
  const { path: p, exists, data } = readOpencodeConfig();
  const missing = missingPermissions(data);
  if (opts.enabled === false) return { path: p, changed: false, missing, disabled: true, dryRun };

  if (missing.length === 0 && exists) {
    return { path: p, changed: false, missing: [], dryRun };
  }

  if (dryRun) {
    return { path: p, changed: false, missing, dryRun };
  }

  // Merge permissions, preserving other keys.
  const merged = { ...data };
  if (!merged.$schema) merged.$schema = "https://opencode.ai/config.json";
  merged.permission = { ...(typeof merged.permission === "object" ? merged.permission : {}), ...REQUIRED_PERMISSIONS };

  ensureDir(path.dirname(p));
  const backupPath = exists ? `${p}.backup.${Date.now()}.${process.pid}` : null;
  if (backupPath) fs.copyFileSync(p, backupPath, fs.constants.COPYFILE_EXCL);
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);

  if (!opts.silent) {
    process.stderr.write(`[opencode-companion] Ensured opencode.json permissions (headless-safe)\n`);
  }
  return { path: p, changed: true, missing, dryRun, backupPath,
    changes: missing.map((key) => ({ key: `permission.${key}`, before: data.permission?.[key] ?? null, after: "allow" })) };
}

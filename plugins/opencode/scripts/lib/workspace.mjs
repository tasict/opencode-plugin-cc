// Workspace detection for the OpenCode companion.

import { getGitRoot } from "./git.mjs";

/**
 * Resolve the workspace root directory.
 * Prefers git root, falls back to cwd.
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function resolveWorkspace(cwd) {
  const dir = cwd || process.cwd();
  const gitRoot = await getGitRoot(dir);
  return gitRoot || dir;
}

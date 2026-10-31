import crypto from "node:crypto";
import path from "node:path";

// Windows Git and shells spell the same workspace with different separators
// and drive casing. State and worktrees must share one identity.
export function workspaceKey(workspace) {
  const canonical = process.platform === "win32" ? path.resolve(workspace).toLowerCase() : workspace;
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

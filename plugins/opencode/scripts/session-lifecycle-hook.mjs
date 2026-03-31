#!/usr/bin/env node

// Session lifecycle hook for the OpenCode companion.
// Called on SessionStart and SessionEnd events to manage the OpenCode server.

import process from "node:process";
import { isServerRunning } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState } from "./lib/state.mjs";

const event = process.argv[2]; // "SessionStart" or "SessionEnd"

async function main() {
  const workspace = await resolveWorkspace();

  if (event === "SessionStart") {
    // Check if OpenCode server is available (but don't auto-start it)
    const running = await isServerRunning();
    if (running) {
      process.stderr.write("[opencode-companion] OpenCode server detected.\n");
    }
  }

  if (event === "SessionEnd") {
    // Clean up: check for any orphaned running jobs and mark them as failed
    const state = loadState(workspace);
    const runningJobs = (state.jobs ?? []).filter((j) => j.status === "running");

    for (const job of runningJobs) {
      if (job.pid) {
        try {
          // Check if process is still alive
          process.kill(job.pid, 0);
        } catch {
          // Process is gone, mark job as failed
          const { upsertJob } = await import("./lib/state.mjs");
          upsertJob(workspace, {
            id: job.id,
            status: "failed",
            completedAt: new Date().toISOString(),
            errorMessage: "Session ended while job was running",
          });
        }
      }
    }
  }
}

main().catch(() => {
  // Hooks should never block the session, so swallow errors silently.
  process.exit(0);
});

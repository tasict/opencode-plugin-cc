import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { loadState, saveState, updateState, generateJobId, upsertJob, stateRoot } from "../plugins/opencode/scripts/lib/state.mjs";

let tmpDir;
const workspace = "/test/workspace";

beforeEach(() => {
  tmpDir = createTmpDir();
  setupTestEnv(tmpDir);
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("state", () => {
  it("loadState returns default when no file exists", () => {
    const state = loadState(workspace);
    assert.deepEqual(state, { config: {}, jobs: [] });
  });

  it("saveState and loadState roundtrip", () => {
    const data = { config: { reviewGate: true }, jobs: [{ id: "test-1" }] };
    saveState(workspace, data);
    const loaded = loadState(workspace);
    assert.deepEqual(loaded, data);
  });

  it("updateState applies mutator", () => {
    const result = updateState(workspace, (state) => {
      state.config.reviewGate = true;
    });
    assert.equal(result.config.reviewGate, true);
  });

  it("generateJobId creates unique IDs with prefix", () => {
    const id1 = generateJobId("review");
    const id2 = generateJobId("review");
    assert.ok(id1.startsWith("review-"));
    assert.notEqual(id1, id2);
  });

  it("upsertJob inserts new job", () => {
    upsertJob(workspace, { id: "job-1", status: "running" });
    const state = loadState(workspace);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, "job-1");
    assert.ok(state.jobs[0].createdAt);
  });

  it("upsertJob updates existing job", () => {
    upsertJob(workspace, { id: "job-1", status: "running" });
    upsertJob(workspace, { id: "job-1", status: "completed" });
    const state = loadState(workspace);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].status, "completed");
  });

  it("stateRoot is deterministic for same workspace", () => {
    const root1 = stateRoot(workspace);
    const root2 = stateRoot(workspace);
    assert.equal(root1, root2);
  });

  it("stateRoot differs for different workspaces", () => {
    const root1 = stateRoot("/workspace/a");
    const root2 = stateRoot("/workspace/b");
    assert.notEqual(root1, root2);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
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
  it("shares state across Windows separators drive casing and dot segments", { skip: process.platform !== "win32" }, () => {
    const first = "C:\\Review\\Workspace";
    saveState(first, { config: {}, jobs: [{ id: "same-job" }] });
    for (const equivalent of ["c:/review/workspace", "C:\\Review\\Workspace\\.", "c:/review/other/../workspace/"]) {
      assert.equal(stateRoot(equivalent), stateRoot(first));
      assert.equal(loadState(equivalent).jobs[0].id, "same-job");
    }
  });
  it("preserves updates from concurrent background workers", async () => {
    const moduleUrl = new URL("../plugins/opencode/scripts/lib/state.mjs", import.meta.url).href;
    const code = "const {upsertJob}=await import(process.argv[1]); for(let i=0;i<10;i++)upsertJob(process.argv[2],{id:process.argv[3]+'-'+i,status:'running'});";
    const results = await Promise.all(["one", "two", "three"].map((worker) => runCommand(process.execPath, ["--input-type=module", "-e", code, moduleUrl, workspace, worker])));
    results.forEach((result) => assert.equal(result.exitCode, 0, result.stderr));
    assert.equal(loadState(workspace).jobs.length, 30);
  });
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

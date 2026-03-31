import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sortJobsNewestFirst,
  matchJobReference,
  resolveResultJob,
  resolveCancelableJob,
  buildStatusSnapshot,
} from "../plugins/opencode/scripts/lib/job-control.mjs";

describe("job-control", () => {
  const jobs = [
    { id: "review-abc", status: "completed", type: "review", updatedAt: "2026-01-01T01:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
    { id: "task-def", status: "running", type: "task", updatedAt: "2026-01-01T02:00:00Z", createdAt: "2026-01-01T01:30:00Z" },
    { id: "task-ghi", status: "failed", type: "task", updatedAt: "2026-01-01T00:30:00Z", createdAt: "2026-01-01T00:00:00Z" },
  ];

  it("sortJobsNewestFirst sorts by updatedAt descending", () => {
    const sorted = sortJobsNewestFirst(jobs);
    assert.equal(sorted[0].id, "task-def");
    assert.equal(sorted[1].id, "review-abc");
    assert.equal(sorted[2].id, "task-ghi");
  });

  it("matchJobReference finds exact match", () => {
    const { job, ambiguous } = matchJobReference(jobs, "task-def");
    assert.equal(job.id, "task-def");
    assert.equal(ambiguous, false);
  });

  it("matchJobReference finds prefix match", () => {
    const { job, ambiguous } = matchJobReference(jobs, "review");
    assert.equal(job.id, "review-abc");
    assert.equal(ambiguous, false);
  });

  it("matchJobReference detects ambiguity", () => {
    const { job, ambiguous } = matchJobReference(jobs, "task");
    assert.equal(job, null);
    assert.equal(ambiguous, true);
  });

  it("matchJobReference returns null for no match", () => {
    const { job, ambiguous } = matchJobReference(jobs, "nonexistent");
    assert.equal(job, null);
    assert.equal(ambiguous, false);
  });

  it("resolveResultJob returns latest finished without ref", () => {
    const { job } = resolveResultJob(jobs);
    assert.equal(job.id, "review-abc");
  });

  it("resolveResultJob includes failed jobs", () => {
    const { job } = resolveResultJob(jobs, "task-ghi");
    assert.equal(job.id, "task-ghi");
  });

  it("resolveCancelableJob returns running job", () => {
    const { job } = resolveCancelableJob(jobs);
    assert.equal(job.id, "task-def");
  });

  it("resolveCancelableJob returns null when no running jobs", () => {
    const noRunning = jobs.filter((j) => j.status !== "running");
    const { job } = resolveCancelableJob(noRunning);
    assert.equal(job, null);
  });

  it("buildStatusSnapshot separates running and finished", () => {
    const snapshot = buildStatusSnapshot(jobs, "/tmp/test");
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0].id, "task-def");
    assert.ok(snapshot.latestFinished);
    assert.equal(snapshot.recent.length, 2);
  });
});

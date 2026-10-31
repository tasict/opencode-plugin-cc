import { it } from "node:test";
import assert from "node:assert/strict";
import { prepareAccess, assertFullAccessPolicy } from "../plugins/opencode/scripts/lib/access.mjs";

it("full access is opt-in and v2 maps to verified --auto", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args.join(" "));
    return { exitCode: 0, stdout: args[0] === "run" ? "--auto --standalone" : JSON.stringify(args[1] === "config" ? [] : [{ id: "build", permissions: [] }]) };
  };
  assert.deepEqual((await prepareAccess({ fullAccess: false, run })).flags, []);
  assert.equal(calls.length, 0);
  assert.deepEqual((await prepareAccess({ fullAccess: true, major: 2, run })).flags, ["--auto"]);
  assert.deepEqual(calls, ["run --help", "debug config", "debug agents"]);
});

it("fails closed on unsupported full access, configured denies and read-only agents", async () => {
  await assert.rejects(prepareAccess({ fullAccess: true, major: 1, agent: "plan" }), /cannot be verified/);
  await assert.rejects(prepareAccess({ fullAccess: true, major: 2, run: async () => ({ stdout: "", exitCode: 0 }) }), /does not support full access/);
  assert.throws(() => assertFullAccessPolicy([{ path: "policy", info: { policies: [{ action: "tool.use", effect: "deny" }] } }], [{ id: "build" }], "build"), /blocked by configuration policy/);
  assert.throws(() => assertFullAccessPolicy([], [{ id: "plan", permissions: [{ action: "edit", effect: "deny" }] }], "plan"), /blocked by agent/);
});

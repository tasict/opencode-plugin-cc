import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverProviders, validateModel, providerError } from "../plugins/opencode/scripts/lib/providers.mjs";

describe("provider CLI fallback", () => {
  it("discovers credentials and models without an HTTP server", async () => {
    const calls = [];
    const run = async (_cmd, args) => {
      calls.push(args);
      return { exitCode: 0, stderr: "", stdout: args[0] === "auth" ? "OpenCode Console Default stored" : "opencode-go/deepseek-v4.1-flash\nopencode/deepseek-v4.1-flash\n" };
    };
    const result = await discoverProviders({ run });
    assert.deepEqual(result.providers, ["opencode-go", "opencode"]);
    assert.equal(result.credentialsDetected, true);
    assert.deepEqual(calls, [["auth", "list"], ["models", "--standalone"]]);
  });
  it("validates model and variant before dispatch", () => {
    assert.deepEqual(validateModel("opencode-go/flash#max", ["opencode-go/flash"]), { providerID: "opencode-go", modelID: "flash", variant: "max" });
    assert.throws(() => validateModel("opencode/missing", []), /Model not found/);
    assert.throws(() => validateModel("oops", []), /Invalid model/);
  });
  it("preserves provider budget error and suggests the same model elsewhere", () => {
    const error = providerError(new Error("Policy budget exceeded"), "opencode/flash#max", ["opencode/flash", "opencode-go/flash"]);
    assert.match(error.message, /Policy budget exceeded/);
    assert.match(error.message, /opencode-go\/flash#max/);
  });
});

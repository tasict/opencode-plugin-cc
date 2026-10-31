import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureOpencodeConfig, resolveConfigPath, missingPermissions } from "../plugins/opencode/scripts/lib/opencode-config.mjs";

describe("permission config repair", () => {
  it("preserves the legacy permission allow shorthand", () => {
    assert.deepEqual(missingPermissions({ permission: "allow" }), []);
  });
  it("backs up exact bytes, reports changes, supports opt-out and rejects malformed config", () => {
    const old = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode cấu hình "));
    process.env.XDG_CONFIG_HOME = dir;
    try {
      const file = resolveConfigPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const original = '{"theme":"dark","permission":{"bash":"ask"}}\n';
      fs.writeFileSync(file, original);
      assert.equal(ensureOpencodeConfig({ enabled: false }).changed, false);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      const result = ensureOpencodeConfig({ silent: true });
      assert.equal(fs.readFileSync(result.backupPath, "utf8"), original);
      assert.deepEqual(result.changes[0], { key: "permission.bash", before: "ask", after: "allow" });
      assert.equal(JSON.parse(fs.readFileSync(file)).theme, "dark");
      assert.equal(ensureOpencodeConfig({ silent: true }).changed, false);
      fs.writeFileSync(file, '{ invalid');
      assert.throws(() => ensureOpencodeConfig({ silent: true }), /JSON/);
      assert.equal(fs.readFileSync(file, "utf8"), '{ invalid');
    } finally {
      if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInvocation } from "../plugins/opencode/scripts/lib/process.mjs";

it("selects the npm script rather than the node.exe existence guard", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-shim-"));
  try {
    fs.writeFileSync(path.join(dir, "entry.mjs"), "");
    const shim = path.join(dir, "fake.cmd");
    fs.writeFileSync(shim, '@echo off\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n SET "_prog=node"\r\n)\r\n"%_prog%" "%dp0%\\entry.mjs" %*\r\n');
    for (const localNode of [false, true]) {
      if (localNode) fs.writeFileSync(path.join(dir, "node.exe"), "guard fixture, must never run");
      assert.deepEqual(resolveInvocation(shim, ["a & b"]), { command: process.execPath, args: [path.join(dir, "entry.mjs"), "a & b"] });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

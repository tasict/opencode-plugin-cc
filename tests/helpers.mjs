// Test helpers for the OpenCode companion tests.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// npm/cmd-shim template, including the node.exe guard and final argv forwarder.
export function npmCmdShim(target) {
  return [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start",
    "SETLOCAL", "CALL :find_dp0", 'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${target}" %*`, "",
  ].join("\r\n");
}

/**
 * Create a temporary directory for test isolation.
 * @param {string} prefix
 * @returns {string}
 */
export function createTmpDir(prefix = "opencode-test") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * Clean up a temporary directory.
 * @param {string} dir
 */
export function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Set up environment for tests.
 * @param {string} tmpDir
 */
export function setupTestEnv(tmpDir) {
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  process.env.OPENCODE_COMPANION_SESSION_ID = "test-session-001";
}

// Filesystem utilities for the OpenCode companion.

import fs from "node:fs";
import path from "node:path";

/**
 * Ensure a directory exists (recursive mkdir).
 * @param {string} dirPath
 */
export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Read a JSON file, returning null on failure.
 * @param {string} filePath
 * @returns {any|null}
 */
export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write a JSON file atomically (write to tmp then rename).
 * @param {string} filePath
 * @param {any} data
 */
export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Append a line to a file.
 * @param {string} filePath
 * @param {string} line
 */
export function appendLine(filePath, line) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

/**
 * Read the last N lines of a file.
 * @param {string} filePath
 * @param {number} n
 * @returns {string[]}
 */
export function tailLines(filePath, n = 10) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

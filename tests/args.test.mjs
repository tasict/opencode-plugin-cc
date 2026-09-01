import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, extractTaskText } from "../plugins/opencode/scripts/lib/args.mjs";

describe("parseArgs", () => {
  it("parses value options", () => {
    const { options } = parseArgs(["--base", "main", "--scope", "branch"], {
      valueOptions: ["base", "scope"],
    });
    assert.equal(options.base, "main");
    assert.equal(options.scope, "branch");
  });

  it("parses boolean options", () => {
    const { options } = parseArgs(["--wait", "--write"], {
      booleanOptions: ["wait", "write"],
    });
    assert.equal(options.wait, true);
    assert.equal(options.write, true);
  });

  it("collects positional arguments", () => {
    const { positional } = parseArgs(["hello", "--wait", "world"], {
      booleanOptions: ["wait"],
    });
    assert.deepEqual(positional, ["hello", "world"]);
  });

  it("collects repeatable array options in order", () => {
    const { options, positional } = parseArgs(
      ["attach", "--file", "a.png", "--file", "b.log", "these", "notes"],
      { arrayOptions: ["file"] }
    );
    assert.deepEqual(options.file, ["a.png", "b.log"]);
    assert.deepEqual(positional, ["attach", "these", "notes"]);
  });

  it("array options are separate from value options", () => {
    const { options } = parseArgs(["--model", "x/y", "--file", "a", "--file", "b"], {
      valueOptions: ["model"],
      arrayOptions: ["file"],
    });
    assert.equal(options.model, "x/y");
    assert.deepEqual(options.file, ["a", "b"]);
  });

  it("handles mixed args", () => {
    const { options, positional } = parseArgs(
      ["fix", "--model", "claude-sonnet", "--write", "the", "bug"],
      { valueOptions: ["model"], booleanOptions: ["write"] }
    );
    assert.equal(options.model, "claude-sonnet");
    assert.equal(options.write, true);
    assert.deepEqual(positional, ["fix", "the", "bug"]);
  });
});

describe("extractTaskText", () => {
  it("strips flags and returns text", () => {
    const text = extractTaskText(
      ["fix", "--model", "claude", "--write", "the", "bug"],
      ["model"],
      ["write"]
    );
    assert.equal(text, "fix the bug");
  });

  it("strips repeated value flags", () => {
    const text = extractTaskText(
      ["--file", "a.png", "review", "--file", "b.log", "this"],
      ["file"],
      []
    );
    assert.equal(text, "review this");
  });

  it("returns empty for flags-only input", () => {
    const text = extractTaskText(["--wait", "--model", "gpt"], ["model"], ["wait"]);
    assert.equal(text, "");
  });
});

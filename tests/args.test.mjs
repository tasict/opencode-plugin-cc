import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, extractTaskText, parseArgumentsInput } from "../plugins/opencode/scripts/lib/args.mjs";

describe("stdin arguments", () => {
  it("preserves contractions and quotes embedded in natural-language tokens", () => {
    assert.deepEqual(parseArgumentsInput("fix the bug, don't crash user's file"), ["fix", "the", "bug,", "don't", "crash", "user's", "file"]);
    assert.deepEqual(parseArgumentsInput('--model "provider/model#max" inspect foo\'bar and foo"bar'), ["--model", "provider/model#max", "inspect", "foo'bar", "and", 'foo"bar']);
    assert.throws(() => parseArgumentsInput('--model "unterminated'), /Unterminated quote/);
  });
  it("preserves literal JSON argv including Windows paths and shell payloads", () => {
    const argv = ['a "b" & c | d % é tiếng Việt', 'C:\\có dấu\\test', '$(touch injected)', ''];
    assert.deepEqual(parseArgumentsInput(JSON.stringify(argv)), argv);
  });
  it("parses slash flags without evaluating shell syntax", () => {
    assert.deepEqual(parseArgumentsInput('--model "provider/model#max" "a & b"'), ['--model','provider/model#max','a & b']);
  });
});

describe("parseArgs", () => {
  it("preserves unknown task flags and honors the end-of-options delimiter", () => {
    assert.deepEqual(parseArgs(["explain", "the", "--verbose", "flag"], { booleanOptions: ["wait"] }), { options: {}, positional: ["explain", "the", "--verbose", "flag"] });
    const argv = ["--wait", "--", "explain", "--model", "--wait"];
    assert.deepEqual(parseArgs(argv, { booleanOptions: ["wait"], valueOptions: ["model"] }), { options: { wait: true }, positional: ["explain", "--model", "--wait"] });
    assert.equal(extractTaskText(argv, ["model"], ["wait"]), "explain --model --wait");
    assert.equal(extractTaskText(["explain", "--verbose", "flag"]), "explain --verbose flag");
  });
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

  it("returns empty for flags-only input", () => {
    const text = extractTaskText(["--wait", "--model", "gpt"], ["model"], ["wait"]);
    assert.equal(text, "");
  });
});

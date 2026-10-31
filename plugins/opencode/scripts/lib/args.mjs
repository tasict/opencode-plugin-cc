// Lightweight argument parser for the OpenCode companion scripts.

// Tokenize data, never evaluate it as shell code. JSON argv is also supported
// for callers needing unambiguous empty strings and embedded newlines.
export function parseArgumentsInput(text) {
  if (text.trimStart().startsWith("[")) {
    const argv = JSON.parse(text);
    if (!Array.isArray(argv) || argv.some((x) => typeof x !== "string")) throw new Error("Expected a JSON string array");
    return argv;
  }
  const result = [];
  let token = "", quote = null, started = false;
  for (const char of text.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (!started && (char === '"' || char === "'")) {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) result.push(token);
      token = ""; started = false;
    } else { token += char; started = true; }
  }
  if (quote) throw new Error("Unterminated quote in arguments; use JSON argv for literal quotes");
  if (started) result.push(token);
  return result;
}

/**
 * Parse CLI arguments into options and positional args.
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 * @returns {{ options: Record<string, string|boolean>, positional: string[] }}
 */
export function parseArgs(argv, schema = {}) {
  const valueSet = new Set(schema.valueOptions ?? []);
  const boolSet = new Set(schema.booleanOptions ?? []);
  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (valueSet.has(key)) {
      options[key] = argv[++i] ?? "";
    } else if (boolSet.has(key)) {
      options[key] = true;
    } else positional.push(arg);
  }

  return { options, positional };
}

/**
 * Extract the natural-language text from argv after stripping known flags.
 * @param {string[]} argv
 * @param {string[]} flagsWithValue - flags that consume the next token
 * @param {string[]} booleanFlags - flags that are standalone
 * @returns {string}
 */
export function extractTaskText(argv, flagsWithValue = [], booleanFlags = []) {
  return parseArgs(argv, { valueOptions: flagsWithValue, booleanOptions: booleanFlags }).positional.join(" ").trim();
}

// Lightweight argument parser for the OpenCode companion scripts.

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
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (valueSet.has(key)) {
      options[key] = argv[++i] ?? "";
    } else if (boolSet.has(key) || !valueSet.has(key)) {
      options[key] = true;
    }
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
  const valSet = new Set(flagsWithValue);
  const boolSet = new Set(booleanFlags);
  const parts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (valSet.has(key)) {
        i++; // skip value
      }
      // skip boolean flags silently
      continue;
    }
    parts.push(arg);
  }

  return parts.join(" ").trim();
}

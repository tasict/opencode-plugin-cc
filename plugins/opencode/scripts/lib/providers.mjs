import { runCommand } from "./process.mjs";

const stripAnsi = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

export async function discoverProviders({ run = runCommand, major = 2, cwd } = {}) {
  const auth = await run("opencode", ["auth", "list"], { cwd, timeoutMs: 60_000 });
  const models = await run("opencode", ["models", ...(major >= 2 ? ["--standalone"] : [])], { cwd, timeoutMs: 60_000 });
  const availableModels = stripAnsi(models.stdout).split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line));
  return {
    providers: [...new Set(availableModels.map((m) => m.split("/")[0]))],
    models: availableModels,
    credentialsDetected: auth.exitCode === 0 && /stored|credential|oauth|api.key/i.test(stripAnsi(auth.stdout)),
    discoveryErrors: [auth, models].filter((r) => r.exitCode !== 0).map((r) => r.stderr.trim()),
  };
}

export function parseModel(model) {
  const match = /^([^/#]+)\/([^#]+)(?:#([^#]+))?$/.exec(model);
  if (!match) throw new Error(`Invalid model ${model}; expected provider/model#variant`);
  return { providerID: match[1], modelID: match[2], variant: match[3] };
}

export function validateModel(model, models) {
  const parsed = parseModel(model);
  const base = `${parsed.providerID}/${parsed.modelID}`;
  if (!models.includes(base)) throw new Error(`Model not found: ${base}. Run opencode models.`);
  return parsed;
}

export function providerError(error, model, models = []) {
  if (!model || !/policy budget exceeded|quota|rate.limit|insufficient|credit/i.test(error.message)) return error;
  const { providerID, modelID, variant } = parseModel(model);
  const alternatives = models.filter((m) => m.endsWith(`/${modelID}`) && !m.startsWith(`${providerID}/`))
    .map((m) => m + (variant ? `#${variant}` : ""));
  return new Error(`${error.message}${alternatives.length ? `\nTry another provider: ${alternatives.join(", ")}` : "\nNo alternative provider for this model was discovered."}`);
}

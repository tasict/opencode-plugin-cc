import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

it("keeps package plugin marketplace skill metadata and changelog versions aligned", () => {
  const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const version = JSON.parse(read("package.json")).version;
  assert.equal(JSON.parse(read("plugins/opencode/.claude-plugin/plugin.json")).version, version);
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(market.version, version);
  assert.equal(market.plugins[0].version, version);
  for (const skill of ["opencode-runtime", "opencode-prompting", "opencode-result-handling"]) {
    assert.ok(read(`plugins/opencode/skills/${skill}/SKILL.md`).split("---")[1].includes(`version: "${version}"`));
  }
  assert.ok(read("CHANGELOG.md").includes(`## ${version}`));
});

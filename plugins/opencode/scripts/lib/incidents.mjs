import fs from "node:fs";
import path from "node:path";

export function incident(file = process.env.OPENCODE_INCIDENT_LOG, type, command, error, resolution) {
  if (!file) return;
  const excerpt = String(error).split(/\r?\n/).slice(0, 40).join("\n");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, `\n## ${new Date().toISOString()} — opencode — delegated job\n- Loại: ${type}\n- Đã làm: ${command}\n- Kết quả: ${excerpt}\n- Xử lý: ${resolution}\n`, "utf8");
}

export function failureType(text) {
  return isBlockedFailure(text) ? "blocked"
    : /timeout|timed out/i.test(text) ? "timeout" : "command_failed";
}

export function isBlockedFailure(text) {
  return /\b(?:permissions? (?:denied|deny|required)|access denied|approval (?:required|requested|needed)|(?:requires?|needs?|awaiting) (?:user )?(?:approval|confirmation|interactive input)|interactive input required|blocked by [^\r\n]{0,100}\bpolicy|full access blocked by)\b/i.test(text);
}

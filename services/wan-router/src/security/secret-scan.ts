import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface SecretFinding {
  rule: string;
  file: string;
  line: number;
}

interface SecretRule {
  id: string;
  expression: RegExp;
}

const RULES: readonly SecretRule[] = [
  { id: "private-key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: "google-api-key", expression: /AIza[0-9A-Za-z_-]{35}/g },
  { id: "openai-api-key", expression: /sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/g },
  { id: "github-token", expression: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: "slack-token", expression: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { id: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  {
    id: "wan-api-key",
    expression: /\bwan_sk_(?:dev|staging|live)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9_-]{32,}\b/g,
  },
  { id: "postgres-password-url", expression: /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@/gi },
];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".tf",
  ".ts",
  ".yaml",
  ".yml",
]);

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

export function scanSecretText(file: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    rule.expression.lastIndex = 0;
    let match = rule.expression.exec(text);
    while (match) {
      findings.push({ rule: rule.id, file, line: lineAt(text, match.index) });
      match = rule.expression.exec(text);
    }
  }
  return findings;
}

function excluded(file: string): boolean {
  const normalized = file.split(path.sep).join("/");
  return normalized.includes("/node_modules/")
    || normalized.includes("/test/")
    || normalized.endsWith(".map")
    || /\/(?:secret-scan|scan-secrets)\.(?:js|ts)$/.test(normalized);
}

async function filesUnder(input: string): Promise<string[]> {
  let metadata;
  try {
    metadata = await stat(input);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if (metadata.isFile()) return TEXT_EXTENSIONS.has(path.extname(input).toLowerCase()) ? [input] : [];
  if (!metadata.isDirectory()) return [];
  const entries = await readdir(input, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesUnder(path.join(input, entry.name))));
  return nested.flat();
}

export async function scanSecretPaths(inputs: readonly string[]): Promise<SecretFinding[]> {
  const files = (await Promise.all(inputs.map(filesUnder))).flat();
  const findings: SecretFinding[] = [];
  for (const file of files.sort()) {
    if (excluded(file)) continue;
    const metadata = await stat(file);
    if (metadata.size > 5 * 1_048_576) continue;
    const text = await readFile(file, "utf8");
    findings.push(...scanSecretText(file, text));
  }
  return findings;
}
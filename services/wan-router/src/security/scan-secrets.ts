import { scanSecretPaths } from "./secret-scan.js";

const inputs = process.argv.slice(2);
const targets = inputs.length ? inputs : ["src", "dist/src", "ops"];
const findings = await scanSecretPaths(targets);
if (findings.length) {
  for (const finding of findings) {
    console.error(`${finding.rule}: ${finding.file}:${finding.line}`);
  }
  console.error(`Secret scan failed with ${findings.length} finding(s).`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${targets.join(", ")}).`);
}
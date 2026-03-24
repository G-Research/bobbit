// Verify the stale draft fix is present in session-manager.ts.
// Pass --master to check master branch (for reproducing-test gate).
// Without --master, checks working tree (for implementation gate).
import fs from "node:fs";
import { execSync } from "node:child_process";

const checkMaster = process.argv.includes("--master");

function readFile(path) {
  if (checkMaster) {
    return execSync(`git show master:${path}`, { encoding: "utf8" });
  }
  return fs.readFileSync(path, "utf8");
}

const src = readFile("src/app/session-manager.ts");
if (!src.includes("clearDraft(sessionId)")) {
  console.error("FAIL: clearDraft(sessionId) not found in session-manager.ts");
  process.exit(1);
} else {
  console.log("PASS: clearDraft(sessionId) found in session-manager.ts");
  process.exit(0);
}

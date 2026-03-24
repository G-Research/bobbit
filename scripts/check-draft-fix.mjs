// Verify the stale draft fix in session-manager.ts.
// Usage:
//   node scripts/check-draft-fix.mjs --master   Check master branch (exits 1 if bug exists)
//   node scripts/check-draft-fix.mjs            Check working tree (exits 0 if fix present)
import fs from "node:fs";
import { execSync } from "node:child_process";

const checkMaster = process.argv.includes("--master");

let src;
if (checkMaster) {
  try {
    src = execSync("git show master:src/app/session-manager.ts", { encoding: "utf8" });
  } catch {
    console.error("FAIL: could not read master:src/app/session-manager.ts");
    process.exit(1);
  }
} else {
  src = fs.readFileSync("src/app/session-manager.ts", "utf8");
}

if (!src.includes("clearDraft(sessionId)")) {
  console.error("FAIL: clearDraft(sessionId) not found in session-manager.ts");
  process.exit(1);
} else {
  console.log("PASS: clearDraft(sessionId) found in session-manager.ts");
  process.exit(0);
}

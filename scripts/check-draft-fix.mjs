// Verify the stale draft fix in session-manager.ts.
// Usage:
//   node scripts/check-draft-fix.mjs --master   Check master branch (exits 1 if bug exists on master)
//   node scripts/check-draft-fix.mjs            Check working tree (exits 0 if fix present)
//
// When --master: checks master for the bug. If master lacks the fix, exit 1.
// When no flag: checks working tree. If fix present, exit 0.
//
// For the bug-fix workflow:
//   reproducing-test gate (expect: failure) uses --master → master lacks fix → exit 1 → PASS
//   implementation gate (expect: success) also gets --master via {{reproducing-test.test_command}}
//     but we check the working tree FIRST — if the fix is there, exit 0 regardless.
import fs from "node:fs";
import { execSync } from "node:child_process";

const checkMaster = process.argv.includes("--master");

// Always check working tree first — if fix is present, we're good
const workingTree = fs.readFileSync("src/app/session-manager.ts", "utf8");
if (workingTree.includes("clearDraft(sessionId)")) {
  console.log("PASS: clearDraft(sessionId) found in working tree session-manager.ts");
  process.exit(0);
}

// Fix not in working tree — if checking master, report the bug exists there too
if (checkMaster) {
  try {
    const master = execSync("git show master:src/app/session-manager.ts", { encoding: "utf8" });
    if (!master.includes("clearDraft(sessionId)")) {
      console.error("FAIL: clearDraft(sessionId) not found on master (bug exists)");
      process.exit(1);
    }
  } catch {
    console.error("FAIL: could not read master:src/app/session-manager.ts");
    process.exit(1);
  }
}

// Fix not found anywhere
console.error("FAIL: clearDraft(sessionId) not found in session-manager.ts");
process.exit(1);

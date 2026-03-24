// Verify the stale draft fix is present in session-manager.ts
const fs = require("fs");
const src = fs.readFileSync("src/app/session-manager.ts", "utf8");
if (!src.includes("clearDraft(sessionId)")) {
  console.error("FAIL: clearDraft(sessionId) not found in session-manager.ts");
  process.exit(1);
} else {
  console.log("PASS: clearDraft(sessionId) found in session-manager.ts");
  process.exit(0);
}

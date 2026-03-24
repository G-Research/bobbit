// Verify the goal creation bug fix is applied in the working tree.
// Exits 0 if the fix is present, exits 1 if the bug still exists.
import fs from "node:fs";

const dialogs = fs.readFileSync("src/app/dialogs.ts", "utf8");
const render = fs.readFileSync("src/app/render.ts", "utf8");

// Find the goal-creation doSave (the one containing createGoal)
const doSaves = [...dialogs.matchAll(/const doSave = async \(\) => \{/g)];
let found = false;
for (const m of doSaves) {
  const chunk = dialogs.slice(m.index, m.index + 1500);
  if (chunk.includes("createGoal")) {
    if (chunk.includes("terminateSession")) {
      console.error("FAIL: dialogs.ts doSave still calls terminateSession");
      process.exit(1);
    }
    found = true;
    break;
  }
}
if (!found) { console.error("FAIL: could not find goal-creation doSave"); process.exit(1); }

// Check render.ts handleCreateGoal
const fnMatch = render.match(/const handleCreateGoal = async \(\) => \{([\s\S]*?)^\t\};/m);
if (!fnMatch) { console.error("FAIL: could not find handleCreateGoal"); process.exit(1); }
if (!fnMatch[1].includes('setHashRoute("goal-dashboard"')) {
  console.error("FAIL: handleCreateGoal does not navigate to goal-dashboard");
  process.exit(1);
}

console.log("OK: goal creation fix verified");

// Verify the goal creation bug fix is applied:
// 1. dialogs.ts doSave near createGoal must NOT call terminateSession
// 2. render.ts handleCreateGoal must navigate to goal-dashboard
//
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

const dialogs = readFile("src/app/dialogs.ts");
const render = readFile("src/app/render.ts");

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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("/qa-test slash skill", () => {
  it("SKILL.md exists and has valid frontmatter", () => {
    const skillPath = path.join(process.cwd(), ".claude", "skills", "qa-test", "SKILL.md");
    assert.ok(fs.existsSync(skillPath), "SKILL.md should exist at .claude/skills/qa-test/SKILL.md");
    
    const content = fs.readFileSync(skillPath, "utf-8");
    
    // Check frontmatter
    assert.ok(content.startsWith("---"), "Should start with YAML frontmatter");
    assert.ok(content.includes("name: qa-test"), "Should have name: qa-test");
    assert.ok(content.includes("description:"), "Should have a description");
    
    // Check key protocol sections
    assert.ok(content.includes("Step 1"), "Should have Step 1");
    assert.ok(content.includes("Step 9") || content.includes("Cleanup"), "Should have cleanup step");
    assert.ok(content.includes("bash_bg"), "Should reference bash_bg for server lifecycle");
    assert.ok(content.includes("qa_start_command"), "Should reference qa_start_command config");
    assert.ok(content.includes("base64"), "Should mention base64 for screenshots");
    assert.ok(content.includes("gate_signal"), "Should reference gate_signal");
  });
});

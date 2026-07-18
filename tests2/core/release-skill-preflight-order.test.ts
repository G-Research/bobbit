import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";

const skill = readFileSync(resolve(process.cwd(), ".claude/skills/release/SKILL.md"), "utf8");
const preflight = skill.match(/## 2\. Pre-flight quality gates[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];

function position(command: string): number {
	assert.ok(preflight, "release skill must contain a fenced pre-flight command block");
	const index = preflight.indexOf(command);
	assert.notEqual(index, -1, `pre-flight command is missing: ${command}`);
	return index;
}

describe("release skill pre-flight order", () => {
	it("builds declarations before type-checking the test graph", () => {
		assert.ok(position("npm ci") < position("npm audit --omit=dev"));
		assert.ok(position("npm audit --omit=dev") < position("npm run build"));
		assert.ok(position("npm run build") < position("npm run check"));
		assert.ok(position("npm run check") < position("npm run test:unit"));
		assert.ok(position("npm run test:unit") < position("npm run test:e2e"));
	});
});

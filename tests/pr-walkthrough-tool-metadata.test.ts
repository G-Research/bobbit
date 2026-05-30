import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const groupDir = path.resolve("defaults/tools/pr-walkthrough");

function readToolText(file: string): string {
	return fs.readFileSync(path.join(groupDir, file), "utf-8");
}

function field(text: string, name: string): string | undefined {
	const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
	return match?.[1]?.replace(/^['\"]|['\"]$/g, "");
}

describe("PR walkthrough tool metadata", () => {
	it("defines readonly_bash as a PR walkthrough extension tool", () => {
		const text = readToolText("readonly_bash.yaml");
		assert.equal(field(text, "name"), "readonly_bash");
		assert.equal(field(text, "group"), "PR Walkthrough");
		assert.match(text, /params:\s*\[command, description\?, timeout\?\]/);
		assert.match(text, /type:\s*bobbit-extension/);
		assert.match(text, /extension:\s*extension\.ts/);
		assert.match(text, /read-only/i);
		assert.match(text, /Blocks writes/i);
	});

	it("defines submit_pr_walkthrough_yaml as a PR walkthrough extension tool", () => {
		const text = readToolText("submit.yaml");
		assert.equal(field(text, "name"), "submit_pr_walkthrough_yaml");
		assert.equal(field(text, "group"), "PR Walkthrough");
		assert.match(text, /params:\s*\[yaml\]/);
		assert.match(text, /type:\s*bobbit-extension/);
		assert.match(text, /extension:\s*extension\.ts/);
		assert.match(text, /YAML/);
	});

	it("extension registers only in walkthrough-scoped sessions and posts scoped YAML payloads", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /const sessionId = process\.env\.BOBBIT_SESSION_ID/);
		assert.match(source, /const jobId = process\.env\.BOBBIT_WALKTHROUGH_JOB_ID/);
		assert.match(source, /if \(!sessionId \|\| !jobId\) return/);
		assert.match(source, /name:\s*"readonly_bash"/);
		assert.match(source, /name:\s*"submit_pr_walkthrough_yaml"/);
		assert.match(source, /\/api\/internal\/pr-walkthrough\/submit-yaml/);
		assert.match(source, /JSON\.stringify\(\{ sessionId, jobId, yaml \}\)/);
	});

	it("readonly_bash extension calls the central policy and returns bounded inline output", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /walkthrough-readonly-policy/);
		assert.match(source, /evaluateWalkthroughReadonlyCommand/);
		assert.match(source, /Command blocked by PR walkthrough read-only policy/);
		assert.match(source, /Use read-only PR\/diff inspection instead/);
		assert.match(source, /truncateTail/);
		assert.doesNotMatch(source, /createWriteStream|tmpdir|tempFilePath|Full output saved to/);
	});
});

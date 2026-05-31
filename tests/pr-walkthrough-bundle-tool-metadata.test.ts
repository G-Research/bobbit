import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { WALKTHROUGH_ALLOWED_TOOLS } from "../src/server/pr-walkthrough/walkthrough-agent-manager.ts";

const groupDir = path.resolve("defaults/tools/pr-walkthrough");

function readToolText(file: string): string {
	return fs.readFileSync(path.join(groupDir, file), "utf-8");
}

function field(text: string, name: string): string | undefined {
	return text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

describe("PR walkthrough bundle access tool metadata", () => {
	it("allows the session-hosted analysis agent to read only its persisted bundle", () => {
		assert.ok(
			WALKTHROUGH_ALLOWED_TOOLS.includes("read_pr_walkthrough_bundle"),
			"WALKTHROUGH_ALLOWED_TOOLS must include read_pr_walkthrough_bundle",
		);
	});

	it("defines read_pr_walkthrough_bundle as a bounded scoped PR walkthrough tool", () => {
		const toolPath = path.join(groupDir, "read_pr_walkthrough_bundle.yaml");
		assert.ok(fs.existsSync(toolPath), "read_pr_walkthrough_bundle.yaml should define the bundle read tool");
		const text = readToolText("read_pr_walkthrough_bundle.yaml");
		assert.equal(field(text, "name"), "read_pr_walkthrough_bundle");
		assert.equal(field(text, "group"), "PR Walkthrough");
		assert.match(text, /params:\s*\[(mode|file|path|index|offset|limit|hunks?)/i);
		assert.match(text, /manifest|summary|file/i);
		assert.match(text, /bounded|limit|truncat/i);
	});

	it("registers read_pr_walkthrough_bundle through the gateway instead of broad filesystem reads", () => {
		const source = readToolText("extension.ts");
		assert.match(source, /name:\s*"read_pr_walkthrough_bundle"/);
		assert.match(source, /BOBBIT_SESSION_ID/);
		assert.match(source, /BOBBIT_WALKTHROUGH_JOB_ID/);
		assert.match(source, /api\/internal\/pr-walkthrough\/(bundle|analysis-bundle)/);
		assert.doesNotMatch(source, /readFileSync\([^)]*BOBBIT_WALKTHROUGH/i, "bundle tool must not read arbitrary env-provided paths from disk");
	});
});

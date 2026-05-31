import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import extension from "../defaults/tools/pr-walkthrough/extension.ts";
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
		assert.match(source, /JSON\.stringify\(\{ \.\.\.readArgs, sessionId, jobId \}\)/, "env-scoped IDs must be appended after whitelisted read args");
		assert.doesNotMatch(source, /JSON\.stringify\(\{ sessionId, jobId, \.\.\.args \}\)/, "tool args must not override scoped session/job IDs");
		assert.doesNotMatch(source, /readFileSync\([^)]*BOBBIT_WALKTHROUGH/i, "bundle tool must not read arbitrary env-provided paths from disk");
	});

	it("read_pr_walkthrough_bundle ignores caller-supplied identity fields at execution", async () => {
		const previousEnv = { ...process.env };
		const previousFetch = globalThis.fetch;
		let postedBody: any;
		try {
			process.env.BOBBIT_SESSION_ID = "env-session";
			process.env.BOBBIT_WALKTHROUGH_JOB_ID = "env-job";
			process.env.BOBBIT_WALKTHROUGH_SUBMIT_PROOF = "proof";
			process.env.BOBBIT_GATEWAY_URL = "https://gateway.test";
			process.env.BOBBIT_TOKEN = "token";
			globalThis.fetch = (async (_url: string, init?: any) => {
				postedBody = JSON.parse(String(init?.body ?? "{}"));
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}) as any;
			let bundleTool: any;
			extension({ registerTool(tool: any) { if (tool.name === "read_pr_walkthrough_bundle") bundleTool = tool; } } as any);
			assert.ok(bundleTool, "expected read_pr_walkthrough_bundle to be registered");

			await bundleTool.execute("call-1", { mode: "file", path: "src/demo.ts", index: 3, offset: 4, limit: 5, hunkOffset: 6, hunkLimit: 7, sessionId: "attacker-session", jobId: "attacker-job", extra: "ignored" });

			assert.deepEqual(postedBody, {
				mode: "file",
				path: "src/demo.ts",
				index: 3,
				offset: 4,
				limit: 5,
				hunkOffset: 6,
				hunkLimit: 7,
				sessionId: "env-session",
				jobId: "env-job",
			});
		} finally {
			globalThis.fetch = previousFetch;
			process.env = previousEnv;
		}
	});
});

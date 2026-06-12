import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import extension from "../market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts";
import { WALKTHROUGH_ALLOWED_TOOLS } from "../src/server/pr-walkthrough/walkthrough-agent-manager.ts";

const groupDir = path.resolve("market-packs/pr-walkthrough/tools/pr-walkthrough");

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
		assert.match(text, /type:\s*bobbit-extension/);
		assert.match(text, /extension:\s*extension\.ts/);
		assert.match(text, /manifest|summary|file/i);
		assert.match(text, /bounded|limit|truncat/i);
	});

	it("registers read_pr_walkthrough_bundle through the gateway instead of broad filesystem reads", () => {
		// host.agents reviewer migration (design Decision C): the server resolves the
		// job binding from the verified X-Bobbit-Session-Secret caller, so the tool sends
		// ONLY the whitelisted read args (no env-scoped sessionId/jobId in the body).
		const source = readToolText("extension.ts");
		assert.match(source, /name:\s*"read_pr_walkthrough_bundle"/);
		assert.match(source, /BOBBIT_SESSION_ID/);
		assert.match(source, /BOBBIT_SESSION_SECRET/);
		assert.match(source, /api\/internal\/pr-walkthrough\/(bundle|analysis-bundle)/);
		assert.match(source, /"X-Bobbit-Session-Secret": sessionSecret/);
		assert.match(source, /JSON\.stringify\(\{ \.\.\.readArgs \}\)/, "the body carries only whitelisted read args; identity comes from the session secret header");
		assert.doesNotMatch(source, /JSON\.stringify\(\{ sessionId, jobId, \.\.\.args \}\)/, "tool args must not override scoped session/job IDs");
		assert.doesNotMatch(source, /readFileSync\([^)]*BOBBIT_WALKTHROUGH/i, "bundle tool must not read arbitrary env-provided paths from disk");
		assert.doesNotMatch(source, /BOBBIT_WALKTHROUGH_JOB_ID/, "the per-job env var is gone (binding-routed)");
	});

	it("read_pr_walkthrough_bundle posts only whitelisted read args, authenticated by the session secret header", async () => {
		const previousEnv = { ...process.env };
		const previousFetch = globalThis.fetch;
		let postedBody: any;
		let postedHeaders: any;
		try {
			process.env.BOBBIT_SESSION_ID = "env-session";
			process.env.BOBBIT_SESSION_SECRET = "env-secret";
			process.env.BOBBIT_GATEWAY_URL = "https://gateway.test";
			process.env.BOBBIT_TOKEN = "token";
			globalThis.fetch = (async (_url: string, init?: any) => {
				postedBody = JSON.parse(String(init?.body ?? "{}"));
				postedHeaders = init?.headers ?? {};
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}) as any;
			let bundleTool: any;
			extension({ registerTool(tool: any) { if (tool.name === "read_pr_walkthrough_bundle") bundleTool = tool; } } as any);
			assert.ok(bundleTool, "expected read_pr_walkthrough_bundle to be registered");

			await bundleTool.execute("call-1", { mode: "file", path: "src/demo.ts", index: 3, offset: 4, limit: 5, hunkOffset: 6, hunkLimit: 7, sessionId: "attacker-session", jobId: "attacker-job", extra: "ignored" });

			// No sessionId/jobId in the body — caller-supplied identity fields are dropped
			// (the body is built from the explicit read-arg whitelist) and the authentic
			// session is proven by the X-Bobbit-Session-Secret header.
			assert.deepEqual(postedBody, {
				mode: "file",
				path: "src/demo.ts",
				index: 3,
				offset: 4,
				limit: 5,
				hunkOffset: 6,
				hunkLimit: 7,
			});
			assert.equal(postedHeaders["X-Bobbit-Session-Secret"], "env-secret");
		} finally {
			globalThis.fetch = previousFetch;
			process.env = previousEnv;
		}
	});
});

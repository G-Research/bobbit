// Ported from tests/headquarters-server-scope-guards.test.ts (straggler-coverage
// -triage PARTIAL — the uncovered sub-behaviours: server-scope role/tool assistant
// cwd defaults + coercion, and archive-bobbit-through-symlink preserving HQ).
// Faithful ports — same assertions, dedicated src-booted gateway (DI deps) instead
// of BOBBIT_TEST_* / BOBBIT_SKIP_* env flags.
//
// The projectless-session MCP fail-closed sub-behaviour is ported separately in
// tests2/core/session-mcp-projectless-fail-closed.test.ts (pure unit).
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardProcessEnv } from "../core/helpers/env-guard.js";
guardProcessEnv();

import { startCustomGateway, type CustomGatewayHandle } from "./_e2e/custom-gateway.js";

function tmpDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function samePath(a: string, b: string): boolean {
	const normalize = (value: string) => {
		let resolved = path.resolve(value);
		try { resolved = fs.realpathSync(resolved); } catch { /* textual fallback */ }
		const normalized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	};
	return normalize(a) === normalize(b);
}

let sharedGateway: CustomGatewayHandle;
let sharedServerRoot: string;

async function withSharedGateway(fn: (gw: CustomGatewayHandle) => Promise<void>): Promise<void> {
	await fn(sharedGateway);
}

describe("Headquarters server-scope guards", () => {
	beforeAll(async () => {
		sharedServerRoot = tmpDir("bobbit-server-scope-assistants-");
		sharedGateway = await startCustomGateway({ serverRoot: sharedServerRoot });
	});

	afterAll(async () => {
		try { await sharedGateway?.shutdown(); }
		finally { if (sharedServerRoot) fs.rmSync(sharedServerRoot, { recursive: true, force: true }); }
	});

	it("server-scope role assistant without cwd defaults to the Headquarters directory", async () => {
		await withSharedGateway(async (gw) => {
			const created = await gw.json("/api/sessions", { method: "POST", body: JSON.stringify({ assistantType: "role", worktree: false }) });
			assert.equal(created.status, 201, JSON.stringify(created.body));
			const hqDir = path.join(gw.serverRoot, ".bobbit", "headquarters");
			assert.ok(samePath(created.body.cwd, hqDir), `expected role assistant cwd ${created.body.cwd} to default to Headquarters dir ${hqDir}`);
		});
	});

	it("server-scope role assistant coerces an explicit cwd outside the Headquarters directory", async () => {
		await withSharedGateway(async (gw) => {
			// An existing on-disk dir outside HQ — the escape must be coerced back to
			// the Headquarters directory, never rejected: server-scope assistants must
			// always create successfully regardless of the caller-supplied cwd.
			const outside = tmpDir("bobbit-role-assistant-escape-");
			try {
				const created = await gw.json("/api/sessions", { method: "POST", body: JSON.stringify({ assistantType: "role", worktree: false, cwd: outside }) });
				assert.equal(created.status, 201, JSON.stringify(created.body));
				const hqDir = path.join(gw.serverRoot, ".bobbit", "headquarters");
				assert.ok(samePath(created.body.cwd, hqDir), `expected role assistant cwd ${created.body.cwd} to be coerced to Headquarters dir ${hqDir}`);
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});
	});

	it("server-scope tool assistant coerces an explicit cwd outside the Headquarters directory", async () => {
		await withSharedGateway(async (gw) => {
			const outside = tmpDir("bobbit-tool-assistant-escape-");
			try {
				const created = await gw.json("/api/sessions", { method: "POST", body: JSON.stringify({ assistantType: "tool", worktree: false, cwd: outside }) });
				assert.equal(created.status, 201, JSON.stringify(created.body));
				const hqDir = path.join(gw.serverRoot, ".bobbit", "headquarters");
				assert.ok(samePath(created.body.cwd, hqDir), `expected tool assistant cwd ${created.body.cwd} to be coerced to Headquarters dir ${hqDir}`);
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});
	});

	it("server-scope assistant accepts an explicit cwd inside the Headquarters directory", async () => {
		await withSharedGateway(async (gw) => {
			const hqSubdir = path.join(gw.serverRoot, ".bobbit", "headquarters", "workspace");
			fs.mkdirSync(hqSubdir, { recursive: true });
			const accepted = await gw.json("/api/sessions", { method: "POST", body: JSON.stringify({ assistantType: "role", worktree: false, cwd: hqSubdir }) });
			assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
			assert.ok(samePath(accepted.body.cwd, hqSubdir), `expected role assistant cwd ${accepted.body.cwd} to be preserved inside Headquarters dir`);
		});
	});

	it("archive-bobbit through a symlink to the server root preserves Headquarters", async (ctx) => {
		const gw = sharedGateway;
		const serverRoot = gw.serverRoot;
		const linkRoot = path.join(os.tmpdir(), `bobbit-archive-root-link-${process.pid}-${Date.now()}`);
		let linked = false;
		try {
			try {
				fs.symlinkSync(serverRoot, linkRoot, process.platform === "win32" ? "junction" : "dir");
				linked = true;
			} catch (err) {
				ctx.skip(`symlink/junction creation unavailable: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}

			const hqSentinel = path.join(serverRoot, ".bobbit", "headquarters", "state", "sentinel.txt");
			fs.mkdirSync(path.dirname(hqSentinel), { recursive: true });
			fs.writeFileSync(hqSentinel, "keep headquarters\n", "utf-8");
			const normalConfig = path.join(serverRoot, ".bobbit", "config", "project.yaml");
			fs.mkdirSync(path.dirname(normalConfig), { recursive: true });
			fs.writeFileSync(normalConfig, "name: normal config\n", "utf-8");

			const archived = await gw.json("/api/projects/archive-bobbit", { method: "POST", body: JSON.stringify({ rootPath: linkRoot }) });
			assert.equal(archived.status, 200, JSON.stringify(archived.body));
			assert.equal(fs.existsSync(hqSentinel), true, "Headquarters state must survive archive via a symlinked server root");
			assert.ok(archived.body.preservedPaths.includes("headquarters"), "archive manifest should record Headquarters as preserved");
		} finally {
			if (linked) { try { fs.rmSync(linkRoot, { recursive: true, force: true }); } catch { /* best-effort */ } }
		}
	});
});

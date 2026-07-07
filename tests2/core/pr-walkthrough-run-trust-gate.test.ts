// Migrated from tests/pr-walkthrough-run-trust-gate.test.ts (v2-core tier).
// node:test default import mapped to the vitest named `test` by hand; relative
// specifiers repointed for tests2/core/.
/**
 * Unit test for the pack `run` route trust pre-check (design §4b.2).
 *
 * The confined worker cannot read the prefs-backed trusted-host list, so for a
 * NON-default host it must NOT spawn a reviewer — it returns HOST_NOT_TRUSTED
 * (host + resolved prUrl) so the client can prompt, persist to githubTrustedHosts,
 * and re-invoke `run` with `trustedHostAck`. github.com never prompts. The ack only
 * governs the (harmless) spawn; the server-side assertTrustedBindingTarget stays the
 * real gate at bundle/submit.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

const { routes } = await import("../../market-packs/pr-walkthrough/lib/routes.mjs");

interface MockCtx {
	ctx: {
		sessionId: string;
		workingDir: string;
		host: {
			store: {
				get(key: string): Promise<unknown>;
				put(key: string, value: unknown): Promise<void>;
				list(prefix: string): Promise<string[]>;
			};
			agents: {
				spawn(opts: unknown): Promise<{ childSessionId: string }>;
				prompt(id: string, msg: string): Promise<void>;
				dismiss(id: string): Promise<void>;
				status(id: string): Promise<{ status: string }>;
			};
		};
	};
	spawnCalls: unknown[];
	promptCalls: { id: string; msg: string }[];
	dismissed: string[];
	store: Map<string, unknown>;
}

function makeCtx(): MockCtx {
	const store = new Map<string, unknown>();
	const spawnCalls: unknown[] = [];
	const promptCalls: { id: string; msg: string }[] = [];
	const dismissed: string[] = [];
	return {
		ctx: {
			sessionId: "parent-session",
			workingDir: "/repo",
			host: {
				store: {
					async get(key: string) { return store.has(key) ? store.get(key) : undefined; },
					async put(key: string, value: unknown) { store.set(key, value); },
					async list(prefix: string) { return [...store.keys()].filter((k) => k.startsWith(prefix)); },
				},
				agents: {
					async spawn(opts: unknown) { spawnCalls.push(opts); return { childSessionId: "child-1" }; },
					async prompt(id: string, msg: string) { promptCalls.push({ id, msg }); },
					async dismiss(id: string) { dismissed.push(id); },
					async status() { return { status: "running" }; },
				},
			},
		},
		spawnCalls,
		promptCalls,
		dismissed,
		store,
	};
}

test("run refuses to spawn for an untrusted (enterprise) host without an ack", async () => {
	const m = makeCtx();
	const result = await routes.run(m.ctx, { body: { prUrl: "https://github.example.com/acme/widgets/pull/7" } });
	assert.equal(result.ok, false);
	assert.equal(result.code, "HOST_NOT_TRUSTED");
	assert.equal(result.retryable, true);
	assert.equal(result.host, "github.example.com");
	assert.equal(result.prUrl, "https://github.example.com/acme/widgets/pull/7");
	assert.equal(m.spawnCalls.length, 0, "no reviewer may be spawned for an untrusted host");
});

test("run spawns for the untrusted host once the client acks it", async () => {
	const m = makeCtx();
	const result = await routes.run(m.ctx, {
		body: { prUrl: "https://github.example.com/acme/widgets/pull/7", trustedHostAck: "github.example.com" },
	});
	assert.equal(result.ok, true);
	assert.equal(result.created, true);
	assert.equal(result.childSessionId, "child-1");
	assert.equal(m.spawnCalls.length, 1, "an acked host must spawn exactly one reviewer");
	assert.equal(m.promptCalls.length, 1);
});

test("run does not require an ack for github.com", async () => {
	const m = makeCtx();
	const result = await routes.run(m.ctx, { body: { prUrl: "https://github.com/SuuBro/bobbit/pull/42" } });
	assert.equal(result.ok, true);
	assert.equal(result.created, true);
	assert.equal(m.spawnCalls.length, 1);
});

test("run normalizes www.github.com to the default-trusted host (no prompt)", async () => {
	const m = makeCtx();
	const result = await routes.run(m.ctx, { body: { prUrl: "https://www.github.com/SuuBro/bobbit/pull/42" } });
	assert.notEqual(result.code, "HOST_NOT_TRUSTED");
	assert.equal(result.ok, true);
	assert.equal(m.spawnCalls.length, 1);
});

test("a mismatched ack for the wrong host still refuses to spawn", async () => {
	const m = makeCtx();
	const result = await routes.run(m.ctx, {
		body: { prUrl: "https://github.example.com/acme/widgets/pull/7", trustedHostAck: "github.com" },
	});
	assert.equal(result.ok, false);
	assert.equal(result.code, "HOST_NOT_TRUSTED");
	assert.equal(m.spawnCalls.length, 0);
});

// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
/**
 * Pinning test for the "Direct-agent admin token" interim rollback.
 *
 * Non-sandboxed ("direct") agents must receive the gateway ADMIN token
 * (readToken()) as BOBBIT_TOKEN / bridgeOptions.gatewayToken, NOT a per-project
 * scoped token. Sandboxed (Docker) agents are unchanged — they keep minting a
 * per-project SCOPED token (distinct from the admin token), preserving the
 * isSandboxAllowed() boundary.
 *
 * The two production methods that build direct-agent credentials
 * (`scopedGatewayEnvForDirectAgent` used by createSession/createDelegateSession,
 * and `applyScopedGatewayCredentials` used by restore/revive/respawn) are
 * private; a full createSession()/createDelegateSession() run needs real git
 * worktrees + agent spawn, so per the design doc we assert the observable
 * behaviour of those methods directly via a typed cast, seeding a real
 * SandboxTokenStore + a temp admin-token file so readToken() returns a known
 * value. The sandbox path is covered by exercising `mintScopedGatewayToken`
 * (what applySandboxWiring uses) and asserting the token differs from admin.
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardProcessEnv } from "../core/helpers/env-guard.js";
guardProcessEnv();

import { SessionManager } from "../../src/server/agent/session-manager.js";
import { SandboxTokenStore } from "../../src/server/auth/sandbox-token.js";
import { readToken } from "../../src/server/auth/token.js";

// A valid admin token must be >= 64 chars (see readToken() in
// src/server/auth/token.ts). Use a recognisable, length-valid fixture.
const TEST_ADMIN_TOKEN = "d".repeat(64);

interface Harness {
	sm: any;
	stateRoot: string;
	restore: () => void;
}

/**
 * Boot a minimal SessionManager against a temp Headquarters dir. When
 * `seedToken` is true, a valid admin token is written where readToken() looks
 * for it (primary serverSecretsDir via BOBBIT_SECRETS_DIR + legacy state-dir
 * fallback). Env is snapshotted/restored by the returned `restore()`.
 */
function makeHarness(opts?: { seedToken?: boolean }): Harness {
	const seedToken = opts?.seedToken ?? true;
	const stateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "direct-token-")));
	const prevBobbitDir = process.env.BOBBIT_DIR;
	const prevSecrets = process.env.BOBBIT_SECRETS_DIR;
	process.env.BOBBIT_DIR = stateRoot;

	const stateDir = path.join(stateRoot, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(stateDir, "gateway-url"), "https://127.0.0.1:3001\n");

	const secretsDir = path.join(stateRoot, "secrets");
	fs.mkdirSync(secretsDir, { recursive: true });
	process.env.BOBBIT_SECRETS_DIR = secretsDir;
	if (seedToken) {
		fs.writeFileSync(path.join(secretsDir, "token"), `${TEST_ADMIN_TOKEN}\n`);
		fs.writeFileSync(path.join(stateDir, "token"), `${TEST_ADMIN_TOKEN}\n`);
	}

	const sm: any = new SessionManager();
	// A real store so the sandbox path can still mint a scoped token; direct
	// paths must NOT consult it.
	sm.sandboxTokenStore = new SandboxTokenStore();

	const restore = () => {
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		if (prevSecrets === undefined) delete process.env.BOBBIT_SECRETS_DIR;
		else process.env.BOBBIT_SECRETS_DIR = prevSecrets;
		try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
	};

	return { sm, stateRoot, restore };
}

describe("direct-agent admin token", () => {
	let current: Harness | undefined;
	afterEach(() => {
		current?.restore();
		current = undefined;
	});

	it("scopedGatewayEnvForDirectAgent (createSession / createDelegateSession path) returns the ADMIN token", () => {
		const h = makeHarness();
		current = h;
		const admin = readToken();
		assert.equal(admin, TEST_ADMIN_TOKEN, "readToken() should return the seeded admin token");

		// Simulates createSession's non-sandboxed branch.
		const sessionEnv = h.sm.scopedGatewayEnvForDirectAgent("sess-1", "proj-1", "goal-1");
		assert.ok(sessionEnv, "direct-agent env must be defined");
		assert.equal(sessionEnv.BOBBIT_TOKEN, admin, "direct session BOBBIT_TOKEN must be the admin token");
		assert.equal(sessionEnv.BOBBIT_GATEWAY_URL, "https://127.0.0.1:3001", "gateway URL wiring must be preserved");

		// Simulates createDelegateSession's non-sandboxed branch (delegate child).
		const delegateEnv = h.sm.scopedGatewayEnvForDirectAgent("sess-1-child", "proj-1", "goal-1");
		assert.ok(delegateEnv, "delegate-child env must be defined");
		assert.equal(delegateEnv.BOBBIT_TOKEN, admin, "delegate child BOBBIT_TOKEN must be the admin token");

		// The store must NOT have been touched by the direct paths (no dead scope
		// entries) — i.e. the admin token is not a registered scoped token.
		assert.equal(h.sm.sandboxTokenStore.lookup(sessionEnv.BOBBIT_TOKEN), undefined,
			"direct token must not be a registered scoped token");
	});

	it("applyScopedGatewayCredentials (restore / respawn / revive path) sets the ADMIN token", () => {
		const h = makeHarness();
		current = h;
		const admin = readToken();

		const bridgeOptions: any = { env: {} };
		h.sm.applyScopedGatewayCredentials(bridgeOptions, "sess-2", "proj-1", "goal-1");
		assert.equal(bridgeOptions.gatewayToken, admin, "restored direct session gatewayToken must be the admin token");
		assert.equal(bridgeOptions.gatewayUrl, "https://127.0.0.1:3001", "gateway URL wiring must be preserved");
	});

	it("sandbox path still mints a SCOPED token distinct from the admin token", () => {
		const h = makeHarness();
		current = h;
		const admin = readToken();

		// applySandboxWiring uses mintScopedGatewayToken — the boundary the guard
		// enforces. It must produce a per-project scoped token, NOT the admin one.
		const scoped = h.sm.mintScopedGatewayToken("proj-1", "sess-3", "goal-1");
		assert.ok(scoped, "sandbox path must mint a scoped token");
		assert.equal(scoped.length, 64, "scoped token is a 64-char hex string");
		assert.notEqual(scoped, admin, "scoped token must be DISTINCT from the admin token");

		// And it is a real registered scope (so isSandboxAllowed can resolve it).
		const scope = h.sm.sandboxTokenStore.lookup(scoped);
		assert.ok(scope, "scoped token must resolve to a registered scope");
		assert.equal(scope.projectId, "proj-1");
	});

	it("fails loudly when no admin token is available (no silent fallback)", () => {
		const h = makeHarness({ seedToken: false });
		current = h;
		assert.equal(readToken(), null, "precondition: no admin token on disk");

		assert.throws(
			() => h.sm.scopedGatewayEnvForDirectAgent("sess-4", "proj-1", "goal-1"),
			/admin token/i,
			"direct env must throw when the admin token is unavailable",
		);
		const bridgeOptions: any = { env: {} };
		assert.throws(
			() => h.sm.applyScopedGatewayCredentials(bridgeOptions, "sess-4", "proj-1", "goal-1"),
			/admin token/i,
			"direct credentials must throw when the admin token is unavailable",
		);
	});
});

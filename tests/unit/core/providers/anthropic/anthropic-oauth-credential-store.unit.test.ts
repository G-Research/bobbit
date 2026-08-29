import { guardProcessEnv } from "../../../../../tests2/core/helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";
import { resetAgentDirStateForTests } from "../../../../../src/server/bobbit-dir.js";
import {
	AtomicCredentialStore,
	__setBeforeStaleLockClaimForTests,
} from "../../../../../src/server/auth/credential-store.js";

const tmp = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-credential-store-"));
const agentDir = path.join(tmp, "agent");
const authPath = path.join(agentDir, "auth.json");
mkdirSync(agentDir, { recursive: true });
process.env.BOBBIT_AGENT_DIR = agentDir;
resetAgentDirStateForTests();

const { getOAuthModels, stopFlowCleanup } = await import("../../../../../src/server/auth/oauth.js");

const realFetch = globalThis.fetch;

/**
 * A credential-free stand-in for Pi's proper-lockfile protocol. Pi resolves
 * the auth file's real path, then atomically creates and heartbeats this empty
 * sibling directory. Keeping the fixture here avoids requiring a root-level
 * proper-lockfile installation in the no-install unit-test gate.
 */
function acquirePiCompatibleExternalLock(file: string): () => Promise<void> {
	const lockPath = `${realpathSync(file)}.lock`;
	mkdirSync(lockPath, { mode: 0o700 });
	const heartbeat = setInterval(() => {
		utimesSync(lockPath, new Date(), new Date());
	}, 1_000);
	return async () => {
		clearInterval(heartbeat);
		rmdirSync(lockPath);
	};
}

function credential(expires = Date.now() + 60 * 60 * 1000): OAuthCredential {
	return {
		type: "oauth",
		access: randomUUID(),
		refresh: randomUUID(),
		expires,
	};
}

function readDocument(): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;
}

function sameSecret(actual: unknown, expected: unknown, message?: string): void {
	assert.equal(actual === expected, true, message);
}

beforeEach(() => {
	process.env.BOBBIT_AGENT_DIR = agentDir;
	resetAgentDirStateForTests();
	rmSync(authPath, { force: true });
	rmSync(`${authPath}.bobbit-rejected-oauth.json`, { force: true });
	rmSync(`${authPath}.bobbit-rejected-oauth.anthropic.json`, { force: true });
	rmSync(`${authPath}.bobbit-rejected-oauth.google-gemini-cli.json`, { force: true });
	rmSync(`${authPath}.lock`, { recursive: true, force: true });
});

afterEach(() => {
	__setBeforeStaleLockClaimForTests(undefined);
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

afterAll(() => {
	stopFlowCleanup();
	rmSync(tmp, { recursive: true, force: true });
});

describe("AtomicCredentialStore", () => {
	it("serializes independent store instances and preserves mixed providers", async () => {
		const stores = [
			new AtomicCredentialStore(authPath),
			new AtomicCredentialStore(authPath),
			new AtomicCredentialStore(authPath),
		];
		const apiKey: Credential = { type: "api_key", key: randomUUID() };
		await stores[0].modify("custom-provider", async () => apiKey);

		const anthropic = credential();
		const google = credential();
		const codex = credential();
		await Promise.all([
			stores[0].modify("anthropic", async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return anthropic;
			}),
			stores[1].modify("google-gemini-cli", async () => google),
			stores[2].modify("openai-codex", async () => codex),
		]);

		const document = readDocument();
		assert.deepEqual(Object.keys(document).sort(), [
			"anthropic",
			"custom-provider",
			"google-gemini-cli",
			"openai-codex",
		]);
		sameSecret(document.anthropic.access, anthropic.access);
		sameSecret(document["google-gemini-cli"].refresh, google.refresh);
		sameSecret(document["openai-codex"].access, codex.access);
		sameSecret(document["custom-provider"].key, apiKey.key);
	});

	it("keeps unrelated fresh reads available while a locked provider callback is stalled", async () => {
		const store = new AtomicCredentialStore(authPath);
		const anthropic = credential();
		const google = credential();
		await store.modify("anthropic", async () => anthropic);
		await store.modify("google-gemini-cli", async () => google);
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => { release = resolve; });
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const mutation = store.modify("anthropic", async () => {
			markStarted();
			await stalled;
			return credential();
		});
		await started;

		const unrelatedRead = store.read("google-gemini-cli");
		const completedWhileStalled = await Promise.race([
			unrelatedRead.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
		]);
		assert.equal(completedWhileStalled, true, "unrelated provider access must not wait for provider I/O");
		release();
		await mutation;
	});

	it("coordinates mutations with Pi's realpath lock while fresh reads remain asynchronous", async (context) => {
		const realDir = path.join(tmp, `real-agent-${randomUUID()}`);
		const aliasDir = path.join(tmp, `alias-agent-${randomUUID()}`);
		mkdirSync(realDir, { recursive: true });
		try {
			symlinkSync(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
		} catch {
			context.skip();
			return;
		}
		const realAuthPath = path.join(realDir, "auth.json");
		const aliasAuthPath = path.join(aliasDir, "auth.json");
		await new AtomicCredentialStore(realAuthPath).modify("anthropic", async () => credential());
		const releaseExternal = acquirePiCompatibleExternalLock(realAuthPath);
		const aliasedStore = new AtomicCredentialStore(aliasAuthPath);
		let mutationEntered = false;
		let released = false;
		try {
			const aliasedMutation = aliasedStore.modify("anthropic", async () => {
				mutationEntered = true;
				return undefined;
			});
			const result = await Promise.race([
				aliasedStore.read("anthropic"),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fresh read waited for writer lock")), 150)),
			]);
			assert.equal(result?.type, "oauth");
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(mutationEntered, false, "canonical mutation must contend on Pi's realpath lock");
			await releaseExternal();
			released = true;
			await aliasedMutation;
			assert.equal(mutationEntered, true);
		} finally {
			if (!released) await releaseExternal().catch(() => {});
		}
	});

	it("heartbeats a Bobbit-held lock before Pi sync can reclaim it and beyond Pi async stale recovery", async () => {
		vi.useFakeTimers();
		try {
			const first = new AtomicCredentialStore(authPath);
			await first.modify("anthropic", async () => credential());

			let releaseHeldMutation!: () => void;
			const held = new Promise<void>((resolve) => { releaseHeldMutation = resolve; });
			let markHeldMutationStarted!: () => void;
			const heldMutationStarted = new Promise<void>((resolve) => { markHeldMutationStarted = resolve; });
			const heldMutation = first.modify("anthropic", async () => {
				markHeldMutationStarted();
				await held;
				return undefined;
			});
			await heldMutationStarted;

			// This is the reverse-direction race: Pi's synchronous proper-lockfile
			// reader can observe Bobbit's shared lock with its 10-second default.
			// Bobbit must refresh before that reader may treat the lock as stale.
			await vi.advanceTimersByTimeAsync(10_001);
			let lockAgeMs = Date.now() - statSync(`${authPath}.lock`).mtimeMs;
			assert.ok(lockAgeMs <= 5_001, "the Bobbit heartbeat must stay within Pi's 10-second synchronous stale deadline");

			// Bobbit's own stale recovery remains aligned with Pi's async 30-second
			// holder lease, so a reloaded gateway also leaves this owner intact.
			await vi.advanceTimersByTimeAsync(20_000);
			lockAgeMs = Date.now() - statSync(`${authPath}.lock`).mtimeMs;
			assert.ok(lockAgeMs <= 5_001, "the Bobbit heartbeat must continue through Pi's async stale deadline");
			let reloadedMutationEntered = false;
			let markReloadedMutationStarted!: () => void;
			const reloadedMutationStarted = new Promise<void>((resolve) => { markReloadedMutationStarted = resolve; });
			const reloadedMutation = new AtomicCredentialStore(authPath).modify("anthropic", async () => {
				reloadedMutationEntered = true;
				markReloadedMutationStarted();
				return undefined;
			});
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(999);
			assert.equal(reloadedMutationEntered, false, "the reloaded store must not reclaim a held, heartbeating lock");

			releaseHeldMutation();
			await heldMutation;
			// The contender can be in the fourth exponential retry (at most 1,600ms).
			// Advancing only that bounded retry avoids draining its new heartbeat.
			await vi.advanceTimersByTimeAsync(1_600);
			await reloadedMutationStarted;
			await reloadedMutation;
			assert.equal(reloadedMutationEntered, true, "the reloaded store must proceed after the original owner releases");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reclaim a Pi async lock before its 30-second stale deadline", async () => {
		vi.useFakeTimers();
		try {
			const store = new AtomicCredentialStore(authPath);
			await store.modify("anthropic", async () => credential());
			const lockPath = `${realpathSync(authPath)}.lock`;
			mkdirSync(lockPath, { mode: 0o700 });
			// Set an externally-owned async Pi lease to 12 seconds old without a
			// wall-clock wait. Bobbit retains Pi's 30-second stale timeout rather
			// than treating synchronous proper-lockfile's shorter default as stale.
			const externalLeaseTime = new Date(Date.now() - 12_000);
			utimesSync(lockPath, externalLeaseTime, externalLeaseTime);
			const externalLock = statSync(lockPath);
			let mutationEntered = false;
			let markMutationStarted!: () => void;
			const mutationStarted = new Promise<void>((resolve) => { markMutationStarted = resolve; });
			const contender = store.modify("anthropic", async () => {
				mutationEntered = true;
				markMutationStarted();
				return undefined;
			});

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			const currentLock = statSync(lockPath);
			assert.equal(currentLock.dev, externalLock.dev, "the external Pi lock must not be reclaimed before its async stale deadline");
			assert.equal(currentLock.ino, externalLock.ino, "the external Pi lock owner must remain intact before 30 seconds");
			assert.equal(mutationEntered, false, "Bobbit must wait for the externally-owned Pi lock");

			rmdirSync(lockPath);
			// The contender can be in the fourth exponential retry (at most 1,600ms).
			// Advancing only that bounded retry avoids draining its new heartbeat.
			await vi.advanceTimersByTimeAsync(1_600);
			await mutationStarted;
			await contender;
			assert.equal(mutationEntered, true, "the contender must proceed once Pi releases its lock");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not reclaim a replacement installed after stale-lock identity verification", async () => {
		const store = new AtomicCredentialStore(authPath);
		await store.modify("anthropic", async () => credential());
		const lockPath = `${authPath}.lock`;
		mkdirSync(lockPath, { mode: 0o700 });
		utimesSync(lockPath, new Date(Date.now() - 30_001), new Date(Date.now() - 30_001));

		let replacement: { dev: number; ino: number } | undefined;
		let replacementSurvived = false;
		let finishInspection!: () => void;
		const inspected = new Promise<void>((resolve) => { finishInspection = resolve; });
		__setBeforeStaleLockClaimForTests((observedLockPath) => {
			// This hook runs immediately before the atomic claim. Keep the displaced
			// stale directory allocated so the fresh replacement has a distinct identity.
			const displacedPath = `${observedLockPath}.fixture-${randomUUID()}`;
			renameSync(observedLockPath, displacedPath);
			mkdirSync(observedLockPath, { mode: 0o700 });
			const stats = statSync(observedLockPath);
			replacement = { dev: stats.dev, ino: stats.ino };
			setTimeout(() => {
				try {
					const current = statSync(observedLockPath);
					replacementSurvived = current.dev === replacement?.dev && current.ino === replacement?.ino;
					rmdirSync(observedLockPath);
				} finally {
					rmdirSync(displacedPath);
					finishInspection();
				}
			}, 20);
		});

		await store.modify("anthropic", async () => {
			await inspected;
			return undefined;
		});
		assert.equal(replacementSurvived, true, "stale recovery must not remove a fresh replacement lock");
	});

	it("does not reclaim a stale lock renewed by its original owner before the final claim", async () => {
		const store = new AtomicCredentialStore(authPath);
		await store.modify("anthropic", async () => credential());
		const lockPath = `${authPath}.lock`;
		mkdirSync(lockPath, { mode: 0o700 });
		utimesSync(lockPath, new Date(Date.now() - 30_001), new Date(Date.now() - 30_001));
		const owner = statSync(lockPath);

		let renewalApplied = false;
		let ownerRetained = false;
		let mutationEntered = false;
		let finishOwnershipCheck!: () => void;
		const ownershipChecked = new Promise<void>((resolve) => { finishOwnershipCheck = resolve; });
		__setBeforeStaleLockClaimForTests((observedLockPath) => {
			// A heartbeat changes mtime, not inode identity. The reclaimer must
			// observe that renewed lease and leave this same owner in place.
			utimesSync(observedLockPath, new Date(), new Date());
			renewalApplied = true;
			setTimeout(() => {
				try {
					const current = statSync(observedLockPath);
					ownerRetained = current.dev === owner.dev && current.ino === owner.ino;
					if (ownerRetained) rmdirSync(observedLockPath);
				} catch {
					ownerRetained = false;
				} finally {
					finishOwnershipCheck();
				}
			}, 20);
		});

		const mutation = store.modify("anthropic", async () => {
			mutationEntered = true;
			return undefined;
		});
		await ownershipChecked;
		assert.equal(renewalApplied, true);
		assert.equal(ownerRetained, true, "a renewed original lock owner must not be reclaimed");
		assert.equal(mutationEntered, false, "the contender must wait for the renewed owner to release");
		await mutation;
	});

	it("holds the canonical lock across refresh callbacks so one rotating token is spent", async () => {
		const first = new AtomicCredentialStore(authPath);
		const second = new AtomicCredentialStore(authPath);
		await first.modify("anthropic", async () => credential(Date.now() - 60_000));
		const rotated = credential();
		let refreshCallbacks = 0;
		const rotate = (store: AtomicCredentialStore) => store.modify("anthropic", async (current) => {
			if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
			refreshCallbacks += 1;
			await new Promise((resolve) => setTimeout(resolve, 50));
			return rotated;
		});

		const [firstResult, secondResult] = await Promise.all([rotate(first), rotate(second)]);
		assert.equal(refreshCallbacks, 1, "the second process must re-check the winner before refreshing");
		const stored = await first.read("anthropic");
		assert.equal(stored?.type, "oauth");
		assert.equal(firstResult?.type, "oauth");
		assert.equal(secondResult?.type, "oauth");
		if (stored?.type === "oauth" && firstResult?.type === "oauth" && secondResult?.type === "oauth") {
			sameSecret(firstResult.access, stored.access);
			sameSecret(secondResult.access, stored.access);
			sameSecret(stored.access, rotated.access);
		}
	});

	it("serializes refresh with Pi's default external file-backed CredentialStore", async () => {
		const expired = credential(Date.now() - 60_000);
		const google = credential();
		const codex = credential();
		const store = new AtomicCredentialStore(authPath);
		await store.modify("anthropic", async () => expired);
		await store.modify("google-gemini-cli", async () => google);
		await store.modify("openai-codex", async () => codex);

		// Omitting `credentials` exercises Pi's own AuthStorage rather than a
		// second Bobbit adapter instance. It snapshots the expired row before the
		// Bobbit runtime starts refreshing, exactly like a separate Pi process.
		const externalPi = await ModelRuntime.create({
			authPath,
			modelsPath: null,
			allowModelNetwork: false,
		});
		const bobbitPi = getOAuthModels();
		const rotatedAccess = randomUUID();
		const rotatedRefresh = randomUUID();
		let networkRequests = 0;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		let releaseNetwork!: () => void;
		const stalledNetwork = new Promise<void>((resolve) => { releaseNetwork = resolve; });
		globalThis.fetch = (async () => {
			networkRequests += 1;
			markStarted();
			await stalledNetwork;
			return new Response(JSON.stringify({
				access_token: rotatedAccess,
				refresh_token: rotatedRefresh,
				expires_in: 3600,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;

		const bobbitRefresh = bobbitPi.getAuth("anthropic");
		await started;
		const externalRefresh = externalPi.getAuth("anthropic");
		await new Promise((resolve) => setTimeout(resolve, 100));
		const requestsBeforeRelease = networkRequests;
		releaseNetwork();
		const [bobbitResolution, externalResolution] = await Promise.all([bobbitRefresh, externalRefresh]);
		assert.equal(requestsBeforeRelease, 1, "external Pi must wait and reuse Bobbit's persisted rotation");
		assert.equal(typeof bobbitResolution?.auth.apiKey, "string");
		assert.equal(typeof externalResolution?.auth.apiKey, "string");
		assert.equal(bobbitResolution?.auth.apiKey === externalResolution?.auth.apiKey, true);
		const document = readDocument();
		sameSecret(document.anthropic.access, rotatedAccess);
		sameSecret(document.anthropic.refresh, rotatedRefresh);
		sameSecret(document["google-gemini-cli"].access, google.access, "Anthropic refresh must preserve Google");
		sameSecret(document["openai-codex"].access, codex.access, "Anthropic refresh must preserve Codex");
	});

	it("freshly reads external changes instead of retaining a credential snapshot", async () => {
		const first = new AtomicCredentialStore(authPath);
		const second = new AtomicCredentialStore(authPath);
		const initial = credential();
		const rotated = credential();
		await first.modify("anthropic", async () => initial);
		const firstRead = await first.read("anthropic");
		assert.equal(firstRead?.type, "oauth");
		sameSecret(firstRead?.type === "oauth" ? firstRead.access : undefined, initial.access);

		await second.modify("anthropic", async () => rotated);
		const refreshedRead = await first.read("anthropic");
		assert.equal(refreshedRead?.type, "oauth");
		sameSecret(refreshedRead?.type === "oauth" ? refreshedRead.access : undefined, rotated.access);
	});

	it("keeps the current rejection fence when a stale rejection arrives later", async () => {
		const store = new AtomicCredentialStore(authPath);
		const stale = credential();
		const current = credential();
		await store.modify("anthropic", async () => current);
		assert.equal(await store.invalidateRejectedOAuthCredential("anthropic", current.access, current.refresh), true);
		assert.equal(await store.invalidateRejectedOAuthCredential("anthropic", stale.access, stale.refresh), false);
		// Model an external process retrying the rejected row after it has observed
		// the durable fence. The stale request must not shadow this current fence.
		writeFileSync(authPath, JSON.stringify({ anthropic: current }), "utf8");
		assert.equal(await store.read("anthropic"), undefined);
	});

	it("removes a rejected tombstone for explicit API-key recovery without deleting healthy OAuth", async () => {
		const store = new AtomicCredentialStore(authPath);
		const rejected = credential();
		await store.modify("anthropic", async () => rejected);
		assert.equal(await store.invalidateRejectedOAuthCredential("anthropic", rejected.access, rejected.refresh), true);
		assert.equal(store.hasRejectedOAuthTombstoneSync("anthropic"), true);

		assert.equal(await store.deleteRejectedOAuthCredential("anthropic"), true);
		assert.equal(store.hasRejectedOAuthTombstoneSync("anthropic"), false);
		assert.equal(readDocument().anthropic, undefined);

		const healthy = credential();
		await store.modify("anthropic", async () => healthy);
		assert.equal(await store.deleteRejectedOAuthCredential("anthropic"), false);
		assert.equal((await store.read("anthropic"))?.type, "oauth");
	});

	it("keeps an in-process current rejection fence when a stale rejection cannot match", async () => {
		const store = new AtomicCredentialStore(authPath);
		const stale = credential();
		const current = credential();
		await store.modify("anthropic", async () => current);
		const atomicWrite = (store as any).atomicWrite.bind(store);
		const failingFence = vi.spyOn(store as any, "atomicWrite").mockImplementation((data: unknown, target: unknown = "") => {
			const targetPath = typeof target === "string" ? target : "";
			if (targetPath.includes(".bobbit-rejected-oauth.anthropic.json")) throw new Error("fence write failed");
			return atomicWrite(data, targetPath);
		});
		try {
			await assert.rejects(store.invalidateRejectedOAuthCredential("anthropic", current.access, current.refresh), /fence write failed/);
			assert.equal(await store.invalidateRejectedOAuthCredential("anthropic", stale.access, stale.refresh), false);
			assert.equal(await store.read("anthropic"), undefined);
		} finally {
			failingFence.mockRestore();
		}
	});

	it("keeps rejection fences provider-scoped and fails closed if their write fails", async () => {
		const store = new AtomicCredentialStore(authPath);
		const anthropic = credential();
		const google = credential();
		await store.modify("anthropic", async () => anthropic);
		await store.modify("google-gemini-cli", async () => google);

		// A malformed Anthropic fence only denies Anthropic; it cannot hide an
		// unrelated provider's otherwise valid OAuth row.
		writeFileSync(`${authPath}.bobbit-rejected-oauth.anthropic.json`, "{", "utf8");
		assert.equal((await store.read("anthropic")), undefined);
		assert.equal((await store.read("google-gemini-cli"))?.type, "oauth");

		const atomicWrite = (store as any).atomicWrite.bind(store);
		const failingFence = vi.spyOn(store as any, "atomicWrite").mockImplementation((data: unknown, target: unknown = "") => {
			const targetPath = typeof target === "string" ? target : "";
			if (targetPath.includes(".bobbit-rejected-oauth.google-gemini-cli.json")) throw new Error("fence write failed");
			return atomicWrite(data, targetPath);
		});
		try {
			await assert.rejects(store.invalidateRejectedOAuthCredential("google-gemini-cli", google.access, google.refresh), /fence write failed/);
			assert.equal(await store.read("google-gemini-cli"), undefined, "the live process must deny an unfenced rejected credential");
		} finally {
			failingFence.mockRestore();
		}
	});

	it("fails closed on malformed external writes without replacing their bytes", async () => {
		const malformed = `{${randomUUID()}`;
		writeFileSync(authPath, malformed, "utf8");
		const store = new AtomicCredentialStore(authPath);
		await assert.rejects(
			store.modify("anthropic", async () => credential()),
			/invalid JSON|JSON object/i,
		);
		assert.equal(readFileSync(authPath, "utf8") === malformed, true);
	});

	it("propagates a cross-store lock ownership compromise instead of treating the mutation as committed", async () => {
		const store = new AtomicCredentialStore(authPath);
		const replacementStore = new AtomicCredentialStore(authPath);
		await assert.rejects(
			store.modify("anthropic", async () => {
				// A separate store performs the actual competing acquisition after the
				// original lease disappears. This is deterministic on every supported
				// filesystem, unlike assuming rmdir/mkdir must allocate a new inode.
				const lockPath = `${realpathSync(authPath)}.lock`;
				rmdirSync(lockPath);
				await replacementStore.modify("openai-codex", async () => credential());
				return credential();
			}),
			/lock was compromised/i,
		);
		const document = readDocument();
		assert.equal(document.anthropic, undefined, "the compromised owner must not commit its mutation");
		assert.equal(document["openai-codex"]?.type, "oauth", "the replacement owner remains intact");
	});

	it("rejects incomplete Anthropic OAuth writes without replacing the existing credential", async () => {
		const store = new AtomicCredentialStore(authPath);
		const existing = credential();
		await store.modify("anthropic", async () => existing);
		await assert.rejects(
			store.modify("anthropic", async () => ({ type: "oauth", access: randomUUID(), expires: Date.now() + 60_000 } as Credential)),
			/incomplete/i,
		);
		const stored = await store.read("anthropic");
		assert.equal(stored?.type, "oauth");
		if (stored?.type === "oauth") sameSecret(stored.access, existing.access);
	});

	it("uses restrictive permissions and removes same-directory temporary files", async () => {
		const store = new AtomicCredentialStore(authPath);
		await store.modify("anthropic", async () => credential());
		assert.equal(existsSync(authPath), true);
		if (process.platform !== "win32") {
			assert.equal(statSync(authPath).mode & 0o777, 0o600);
		}
		assert.deepEqual(
			readdirSync(agentDir).filter((name) => name.includes(".bobbit-") && name.endsWith(".tmp")),
			[],
		);
	});
});


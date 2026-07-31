import { guardProcessEnv } from "./helpers/env-guard.js";
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
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { AtomicCredentialStore } from "../../src/server/auth/credential-store.js";

const tmp = mkdtempSync(path.join(tmpdir(), "bobbit-anthropic-persistence-"));
const agentDir = path.join(tmp, "agent");
const authPath = path.join(agentDir, "auth.json");
mkdirSync(agentDir, { recursive: true });
process.env.BOBBIT_AGENT_DIR = agentDir;
resetAgentDirStateForTests();

const {
	getOAuthCredentialStore,
	getOAuthModels,
	oauthStatus,
	refreshGoogleOAuthToken,
	refreshOAuthToken,
	stopFlowCleanup,
} = await import("../../src/server/auth/oauth.js");

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

function isolatedPersistenceProbe(file: string): Promise<{ configured: boolean; refreshable: boolean; keys: string[] }> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(`
			const { parentPort, workerData } = require("node:worker_threads");
			const { readFileSync } = require("node:fs");
			try {
				const row = JSON.parse(readFileSync(workerData, "utf8")).anthropic;
				parentPort.postMessage({
					configured: row?.type === "oauth",
					refreshable: typeof row?.refresh === "string" && row.refresh.length > 0,
					keys: row && typeof row === "object" ? Object.keys(row).sort() : [],
				});
			} catch (error) {
				parentPort.postMessage({ configured: false, refreshable: false, keys: [] });
			}
		`, { eval: true, workerData: file });
		worker.once("message", resolve);
		worker.once("error", reject);
		worker.once("exit", (code) => {
			if (code !== 0) reject(new Error(`isolated persistence probe exited ${code}`));
		});
	});
}

beforeEach(() => {
	process.env.BOBBIT_AGENT_DIR = agentDir;
	resetAgentDirStateForTests();
	rmSync(authPath, { force: true });
	rmSync(`${authPath}.lock`, { recursive: true, force: true });
});

afterEach(() => {
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

describe("Anthropic persisted status and Pi refresh", () => {
	it("treats an expired refreshable credential as configured across an isolated restart probe", async () => {
		const expired = credential(Date.now() - 60_000);
		await new AtomicCredentialStore(authPath).modify("anthropic", async () => expired);

		// Tier-1 forbids child processes, so a worker provides a fresh execution
		// isolate and returns allow-listed metadata only. It shares no module cache
		// or credential-store instance with the writer.
		assert.deepEqual(await isolatedPersistenceProbe(authPath), {
			configured: true,
			refreshable: true,
			keys: ["access", "expires", "refresh", "type"],
		});
		const afterRestart = await new AtomicCredentialStore(authPath).read("anthropic");
		assert.equal(afterRestart?.type, "oauth");
		sameSecret(afterRestart?.type === "oauth" ? afterRestart.refresh : undefined, expired.refresh);
		const status = await oauthStatus("anthropic") as Record<string, unknown>;
		assert.equal(status.authenticated, true);
		assert.deepEqual(Object.keys(status).sort(), ["authenticated", "expires", "provider"]);
		assert.equal(JSON.stringify(status).includes(String(expired.access)), false);
		assert.equal(JSON.stringify(status).includes(String(expired.refresh)), false);
	});

	it("observes provider deletion performed through another store immediately", async () => {
		await getOAuthCredentialStore().modify("anthropic", async () => credential());
		assert.equal((await oauthStatus("anthropic")).authenticated, true);
		await new AtomicCredentialStore(authPath).delete("anthropic");
		assert.equal((await oauthStatus("anthropic")).authenticated, false);
	});

	it("keeps status available while Anthropic refresh network I/O is stalled", async () => {
		const expired = credential(Date.now() - 60_000);
		await new AtomicCredentialStore(authPath).modify("anthropic", async () => expired);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => { release = resolve; });
		globalThis.fetch = (async () => {
			markStarted();
			await stalled;
			return new Response(JSON.stringify({
				access_token: randomUUID(),
				refresh_token: randomUUID(),
				expires_in: 3600,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;

		const refresh = refreshOAuthToken();
		await started;
		const status = await Promise.race([
			oauthStatus("anthropic"),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("status blocked behind refresh")), 150)),
		]);
		assert.equal(status.authenticated, true);
		release();
		assert.equal(typeof await refresh, "string");
	});

	it("delegates expired credential rotation to Pi's current token endpoint", async () => {
		const expired = credential(Date.now() - 60_000);
		const google = credential();
		const codex = credential();
		const store = new AtomicCredentialStore(authPath);
		await store.modify("anthropic", async () => expired);
		await store.modify("google-gemini-cli", async () => google);
		await store.modify("openai-codex", async () => codex);

		const rotatedAccess = randomUUID();
		const rotatedRefresh = randomUUID();
		let seenUrl: string | undefined;
		let seenGrant: string | undefined;
		let refreshMatched = false;
		let refreshWasBounded = false;
		globalThis.fetch = (async (input, init) => {
			seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			seenGrant = typeof body.grant_type === "string" ? body.grant_type : undefined;
			refreshMatched = body.refresh_token === expired.refresh;
			refreshWasBounded = init?.signal instanceof AbortSignal;
			return new Response(JSON.stringify({
				access_token: rotatedAccess,
				refresh_token: rotatedRefresh,
				expires_in: 3600,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;

		const resolved = await refreshOAuthToken();
		sameSecret(resolved, rotatedAccess);
		assert.equal(seenUrl, "https://platform.claude.com/v1/oauth/token");
		assert.equal(seenGrant, "refresh_token");
		assert.equal(refreshMatched, true, "Pi must receive the currently stored refresh credential");
		assert.equal(refreshWasBounded, true, "Pi's provider refresh must carry a timeout signal");
		const document = readDocument();
		assert.deepEqual(Object.keys(document.anthropic).sort(), ["access", "expires", "refresh", "type"]);
		sameSecret(document.anthropic.access, rotatedAccess);
		sameSecret(document.anthropic.refresh, rotatedRefresh, "rotated refresh credential must replace the old value");
		sameSecret(document["google-gemini-cli"].access, google.access, "Anthropic refresh must preserve Google");
		sameSecret(document["openai-codex"].access, codex.access, "Anthropic refresh must preserve Codex");
	});

	it("keeps Anthropic and Codex intact when the Google writer refreshes", async () => {
		const anthropic = credential();
		const codex = credential();
		const expiredGoogle = credential(Date.now() - 60_000);
		const store = new AtomicCredentialStore(authPath);
		await store.modify("anthropic", async () => anthropic);
		await store.modify("openai-codex", async () => codex);
		await store.modify("google-gemini-cli", async () => expiredGoogle);
		const rotatedGoogleAccess = randomUUID();
		let refreshWasBounded = false;
		const googleFetch: typeof fetch = async (_input, init) => {
			refreshWasBounded = init?.signal instanceof AbortSignal;
			return new Response(JSON.stringify({
				access_token: rotatedGoogleAccess,
				expires_in: 3600,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const resolved = await refreshGoogleOAuthToken(googleFetch);
		assert.equal(refreshWasBounded, true, "Google refresh must be bounded while holding the credential lock");
		sameSecret(resolved, rotatedGoogleAccess);
		const document = readDocument();
		sameSecret(document["google-gemini-cli"].access, rotatedGoogleAccess);
		sameSecret(document["google-gemini-cli"].refresh, expiredGoogle.refresh);
		sameSecret(document.anthropic.access, anthropic.access, "Google refresh must preserve Anthropic");
		sameSecret(document["openai-codex"].access, codex.access, "Google refresh must preserve Codex");
	});

	it("does not block Anthropic reads while Google refresh network I/O is stalled", async () => {
		const anthropic = credential();
		const expiredGoogle = credential(Date.now() - 60_000);
		const store = new AtomicCredentialStore(authPath);
		await store.modify("anthropic", async () => anthropic);
		await store.modify("google-gemini-cli", async () => expiredGoogle);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => { release = resolve; });
		const googleRefresh = refreshGoogleOAuthToken(async () => {
			markStarted();
			await stalled;
			return new Response(JSON.stringify({ access_token: randomUUID(), expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		await started;
		const available = await Promise.race([
			store.read("anthropic").then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
		]);
		assert.equal(available, true);
		release();
		assert.equal(typeof await googleRefresh, "string");
	});

	it("redacts upstream token-shaped refresh failures and removes definitively rejected credentials", async () => {
		const expired = credential(Date.now() - 60_000);
		await new AtomicCredentialStore(authPath).modify("anthropic", async () => expired);
		const providerSecret = randomUUID();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		globalThis.fetch = (async () => new Response(
			JSON.stringify({ error: "invalid_grant", refresh_token: providerSecret }),
			{ status: 401, headers: { "Content-Type": "application/json" } },
		)) as typeof fetch;

		assert.equal(await refreshOAuthToken(), null);
		const output = errors.mock.calls.flat().join(" ");
		assert.equal(output.includes(providerSecret), false, "provider response token must not be logged");
		assert.equal(output.includes(String(expired.refresh)), false, "stored refresh credential must not be logged");
		assert.equal(await new AtomicCredentialStore(authPath).read("anthropic"), undefined);
		assert.equal((await oauthStatus("anthropic")).authenticated, false);
	});
});

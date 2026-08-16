import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	ServiceRuntimeStore,
	ServiceRuntimeStoreError,
	sanitizeRuntimeArtifact,
	type PersistedServiceRuntime,
} from "../../src/server/service-runtime/service-runtime-store.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "bobbit-service-runtime-store-"));
	roots.push(root);
	return root;
}

function record(overrides: Partial<PersistedServiceRuntime> = {}): PersistedServiceRuntime {
	return {
		version: 1,
		serverIdentity: "server-1",
		desired: "running",
		selectedMode: "local",
		settingsRevision: "rev-1",
		restartAttempts: [],
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("ServiceRuntimeStore", () => {
	it("durably replaces versioned desired state with owner-only files", async () => {
		const root = await temporaryRoot();
		const store = new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1" });
		const identity = store.identity("@bobbit/hindsight", "hindsight");

		const storageIdentity = "hindsight-managed:0123456789abcdef";
		await store.replace(identity, record({ storageIdentity }));
		await store.replace(identity, record({ desired: "stopped", selectedMode: "docker", settingsRevision: "rev-2", storageIdentity }));

		// A new store instance simulates a gateway restart: the opaque continuity
		// identity must survive independently of in-memory runtime state.
		const afterRestart = new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1" });
		assert.deepEqual(await afterRestart.load(identity), record({ desired: "stopped", selectedMode: "docker", settingsRevision: "rev-2", storageIdentity }));
		const runtimeDir = path.join(root, "service-runtimes", Buffer.from("@bobbit/hindsight").toString("base64url"), "hindsight");
		if (process.platform !== "win32") {
			assert.equal((await stat(path.join(runtimeDir, "state.json"))).mode & 0o777, 0o600);
			assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
		}
		assert.deepEqual((await store.list()).map((entry) => entry.identity), [identity]);
	});

	it("fails closed on corrupt records and never accepts metadata secret fields", async () => {
		const root = await temporaryRoot();
		const store = new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1" });
		const identity = store.identity("pack", "runtime");
		await assert.rejects(
			store.replace(identity, { ...record(), secret: "not-allowed" } as PersistedServiceRuntime),
			(error: unknown) => error instanceof ServiceRuntimeStoreError && error.code === "SERVICE_RUNTIME_STORE_CORRUPT",
		);
		await assert.rejects(
			store.replace(identity, record({ storageIdentity: "postgresql://user:secret@db.example/hindsight" })),
			(error: unknown) => error instanceof ServiceRuntimeStoreError && error.code === "SERVICE_RUNTIME_STORE_CORRUPT",
		);

		const state = path.join(root, "service-runtimes", Buffer.from("pack").toString("base64url"), "runtime", "state.json");
		await mkdir(path.dirname(state), { recursive: true });
		await writeFile(state, "{not json", { mode: 0o600 });
		await assert.rejects(
			store.load(identity),
			(error: unknown) => error instanceof ServiceRuntimeStoreError && error.code === "SERVICE_RUNTIME_STORE_CORRUPT",
		);
	});

	it("reads legacy records without a continuity key for explicit safe compatibility handling", async () => {
		const root = await temporaryRoot();
		const store = new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1" });
		const identity = store.identity("pack", "runtime");
		await store.replace(identity, record());
		assert.deepEqual(await new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1" }).load(identity), record());
	});

	it("keeps generated and user secrets in injected owners while artifacts are redacted and bounded", async () => {
		const root = await temporaryRoot();
		const generated = new Map<string, string>();
		let userLookups = 0;
		const store = new ServiceRuntimeStore({
			stateDir: root,
			serverIdentity: "server-1",
			generatedSecrets: { get: (key) => generated.get(key), set: (key, value) => { generated.set(key, value); } },
			userSecrets: { resolveSecret: (setting) => { userLookups++; return setting === "apiKey" ? "user-value" : undefined; } },
			generateSecret: () => "generated-value",
		});
		const identity = store.identity("pack", "runtime");
		assert.equal(await store.getOrCreateGeneratedSecret(identity, "TOKEN"), "generated-value");
		assert.equal(await store.getOrCreateGeneratedSecret(identity, "TOKEN"), "generated-value");
		assert.equal(generated.size, 1);
		assert.equal(await store.resolveUserSecret("apiKey"), "user-value");
		assert.equal(userLookups, 1);

		await store.replace(identity, record());
		await store.writeEnvironment(identity, { TOKEN: "generated-value", API_KEY: "user-value" });
		const envFile = await store.environmentFile(identity);
		assert.equal(envFile, path.join(root, "service-runtimes", Buffer.from("pack").toString("base64url"), "runtime", "runtime.env"));
		if (process.platform !== "win32") assert.equal((await stat(envFile)).mode & 0o777, 0o600);
		await store.writeLog(identity, Array.from({ length: 240 }, (_, i) => `TOKEN=generated-value user-value ${i}`).join("\n"), ["generated-value", "user-value"]);
		const log = await store.readLog(identity);
		assert.ok(log?.includes("TOKEN=[REDACTED]"));
		assert.ok(!log?.includes("generated-value") && !log?.includes("user-value"));
		assert.ok((log?.split("\n").length ?? 0) <= 200);
		assert.ok(Buffer.byteLength(log ?? "") <= 64 * 1024);
		const stateText = await readFile(path.join(root, "service-runtimes", Buffer.from("pack").toString("base64url"), "runtime", "state.json"), "utf8");
		assert.ok(!stateText.includes("generated-value") && !stateText.includes("user-value"));
	});

	it("refuses a missing or non-owner-only environment artifact on POSIX", async () => {
		if (process.platform === "win32") return;
		const root = await temporaryRoot();
		const store = new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1" });
		const identity = store.identity("pack", "runtime");
		await assert.rejects(store.environmentFile(identity), { code: "SERVICE_RUNTIME_STORE_ENV_UNAVAILABLE" });
		await store.writeEnvironment(identity, { VALUE: "value" });
		const envFile = await store.environmentFile(identity);
		await writeFile(envFile, "VALUE=bad\n");
		await chmod(envFile, 0o644);
		await assert.rejects(store.environmentFile(identity), { code: "SERVICE_RUNTIME_STORE_CORRUPT" });
	});

	it("accepts regular environment artifacts but rejects symlinks on Windows", async () => {
		const root = await temporaryRoot();
		const store = new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1", platform: "win32" });
		const identity = store.identity("pack", "runtime");
		await store.writeEnvironment(identity, { VALUE: "value" });
		const envFile = await store.environmentFile(identity);
		await chmod(envFile, 0o644);
		assert.equal(await store.environmentFile(identity), envFile);

		const target = path.join(root, "untrusted.env");
		await writeFile(target, "VALUE=untrusted\n");
		await rm(envFile);
		await symlink(target, envFile);
		await assert.rejects(store.environmentFile(identity), { code: "SERVICE_RUNTIME_STORE_CORRUPT" });
	});

	it("preserves storage on remove and only purges declared, contained storage after confirmation", async () => {
		const root = await temporaryRoot();
		const ownedRoot = path.join(root, "service-data");
		const dataPath = path.join(ownedRoot, "hindsight");
		await mkdir(dataPath, { recursive: true });
		await writeFile(path.join(dataPath, "data.db"), "keep me");
		const store = new ServiceRuntimeStore({ stateDir: root, serverIdentity: "server-1" });
		const identity = store.identity("pack", "runtime");
		await store.replace(identity, record());
		await store.remove(identity);
		assert.equal(await readFile(path.join(dataPath, "data.db"), "utf8"), "keep me");

		await store.replace(identity, record());
		let stopped = false;
		await store.purge(identity, {
			confirmation: identity,
			storage: { ownedRoot, dataPath },
			stop: async () => { stopped = true; },
		});
		assert.equal(stopped, true);
		await assert.rejects(stat(dataPath));
		assert.equal(await store.load(identity), undefined);

		await assert.rejects(
			store.purge(identity, { confirmation: identity, storage: { ownedRoot, dataPath: root } }),
			(error: unknown) => error instanceof ServiceRuntimeStoreError && error.code === "SERVICE_RUNTIME_PURGE_INVALID_STORAGE",
		);
	});

	it("sanitizes assignment forms before bounding artifacts", () => {
		const output = sanitizeRuntimeArtifact("PASSWORD=abc123 and abc123", ["abc123"]);
		assert.equal(output, "PASSWORD=[REDACTED] and [REDACTED]");
	});

	it("redacts encoded and decoded PostgreSQL userinfo passwords", () => {
		const databaseUrl = "postgresql://hindsight:p%40ss%2Fword@db.example:5432/hindsight";
		const output = sanitizeRuntimeArtifact(
			`connection=${databaseUrl}\npassword=p%40ss%2fword\npassword=p@ss/word`,
			[databaseUrl],
		);
		assert.ok(!output.includes(databaseUrl));
		assert.ok(!output.includes("p%40ss%2Fword") && !output.includes("p%40ss%2fword") && !output.includes("p@ss/word"));
	});

	it("redacts decoded and encoded PostgreSQL credential query values", () => {
		const databaseUrl = "postgresql://hindsight@db.example:5432/hindsight?sslmode=require&password=query%2Dpassword&access_token=token%2Fvalue";
		const output = sanitizeRuntimeArtifact(
			`url=${databaseUrl}\npassword=query%2dpassword\npassword=query-password\naccess_token=token%2fvalue\naccess_token=token/value`,
			[databaseUrl],
		);
		assert.ok(!output.includes(databaseUrl));
		assert.ok(!output.includes("query%2Dpassword") && !output.includes("query%2dpassword") && !output.includes("query-password") && !output.includes("token%2Fvalue") && !output.includes("token%2fvalue") && !output.includes("token/value"));
	});
});

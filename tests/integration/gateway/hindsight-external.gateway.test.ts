import { test as base, expect } from "./_helpers/e2e/in-process-harness.js";
import { enableTsWorkerResolver } from "../../unit/core/_helpers/enable-ts-worker.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	agentEndPredicate,
	messageEndPredicate,
	waitForCondition,
	nonGitCwd,
} from "./_helpers/e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACK_NAME = "hindsight";
const PROVIDER_ID = "memory";
const PRODUCTION_LIFECYCLE_BUDGET = "budget: { maxTokens: 1200, timeoutMs: 1500 }";
const TEST_LIFECYCLE_BUDGET = "budget: { maxTokens: 1200, timeoutMs: 10000 }";
const PACK_SRC = path.resolve(__dirname, "..", "..", "..", "market-packs", PACK_NAME);
const STUB_PATH = path.resolve(__dirname, "..", "..", "..", "tests", "e2e", "hindsight-stub.mjs");
const CONFIG_STORE_KEY = "provider-config:memory";
const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "pack.yaml")) &&
	fs.existsSync(path.join(PACK_SRC, "lib", "provider.mjs")) &&
	fs.existsSync(STUB_PATH);

const test = base;
const describe = DEPS_READY ? test.describe : test.describe.skip;

interface RetainedItem { content: string; tags: string[]; async: boolean }
interface RecordedCall { method: string; path: string; bank?: string; body?: unknown }
interface HindsightStub {
	url: string;
	calls: RecordedCall[];
	seedMemories(bank: string, memories: { text: string; id?: string }[]): void;
	retained(bank?: string): RetainedItem[];
	close(): Promise<void>;
}

async function startStub(): Promise<HindsightStub> {
	const mod = await import(STUB_PATH as string);
	const start = mod.startHindsightStub ?? mod.default;
	return start({ port: 0 }) as Promise<HindsightStub>;
}

function installPack(headquartersDir: string): string {
	const packDir = path.join(headquartersDir, "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(PACK_SRC, packDir, { recursive: true });

	// Starting a TypeScript module worker is fixture overhead, so retain the
	// existing integration-only lifecycle budget while preserving production yaml.
	const providerYaml = path.join(packDir, "providers", "memory.yaml");
	const yaml = fs.readFileSync(providerYaml, "utf-8");
	if (!yaml.includes(PRODUCTION_LIFECYCLE_BUDGET)) {
		throw new Error("Hindsight test fixture could not find the production lifecycle budget");
	}
	fs.writeFileSync(providerYaml, yaml.replace(PRODUCTION_LIFECYCLE_BUDGET, TEST_LIFECYCLE_BUDGET), "utf-8");
	fs.writeFileSync(
		path.join(packDir, ".pack-meta.yaml"),
		[
			"sourceUrl: e2e",
			"sourceRef: local",
			"commit: test",
			`packName: ${PACK_NAME}`,
			"version: 1.0.0",
			"installedAt: '2026-01-01T00:00:00.000Z'",
			"updatedAt: '2026-01-01T00:00:00.000Z'",
			"scope: server",
		].join("\n") + "\n",
		"utf-8",
	);
	return packDir;
}

function encodeStoreKey(key: string): string {
	let out = "";
	for (const byte of Buffer.from(key, "utf8")) {
		const isAlnum = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
		out += isAlnum ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

function seedConfig(bobbitDir: string, config: Record<string, unknown> | null): void {
	const file = path.join(bobbitDir, "state", "ext-store", PACK_NAME, `${encodeStoreKey(CONFIG_STORE_KEY)}.json`);
	if (config === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ v: 1, value: config }), "utf-8");
}

async function setProviderDisabled(providers: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { providers } }),
	});
	expect(response.status).toBe(200);
}

async function readServerPackOrder(): Promise<string[]> {
	const response = await apiFetch("/api/marketplace/pack-order?scope=server");
	expect(response.status).toBe(200);
	return (await response.json()).order as string[];
}

/** Notify the gateway after this fixture's direct on-disk install/uninstall. */
async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status).toBe(200);
}

async function callBeforePrompt(sessionId: string, prompt: string, sessionSecret: string): Promise<{ status: number; content: string }> {
	const response = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		headers: { "X-Bobbit-Session-Secret": sessionSecret },
		body: JSON.stringify({ prompt }),
	});
	const body = response.status === 200 ? await response.json() : {};
	return { status: response.status, content: typeof body.content === "string" ? body.content : "" };
}

async function driveTurn(sessionId: string, prompt: string): Promise<void> {
	const connection = await connectWs(sessionId);
	try {
		const userEnd = connection.waitFor(messageEndPredicate("user"));
		connection.send({ type: "prompt", text: prompt });
		await userEnd;
		await connection.waitFor(agentEndPredicate(), 15_000);
	} finally {
		connection.close();
	}
}

describe.configure({ mode: "serial" });

describe("hindsight installed-provider worker boundary", () => {
	const sessionIds: string[] = [];
	const cwds: string[] = [];
	let bobbitDir: string;
	let packDir: string;
	let originalPackOrder: string[];
	let stub: HindsightStub;

	test.beforeAll(async ({ gateway }) => {
		enableTsWorkerResolver();
		bobbitDir = gateway.bobbitDir;
		originalPackOrder = await readServerPackOrder();
		packDir = installPack(bobbitDir);
		await notifyPackFilesystemMutation(originalPackOrder);
		stub = await startStub();
	});

	test.afterAll(async () => {
		await setProviderDisabled([PROVIDER_ID]).catch(() => {});
		seedConfig(bobbitDir, null);
		for (const sessionId of sessionIds) await deleteSession(sessionId).catch(() => {});
		for (const cwd of cwds) fs.rmSync(cwd, { recursive: true, force: true });
		if (stub) await stub.close().catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		if (originalPackOrder) await notifyPackFilesystemMutation(originalPackOrder).catch(() => {});
	});

	test("configured pack recalls and retains through ModuleHost and the host-store proxy", async ({ gateway }) => {
		seedConfig(bobbitDir, {
			mode: "external",
			externalUrl: stub.url,
			bank: "bobbit",
			namespace: "default",
			recallScope: "all",
			autoRecall: true,
			autoRetain: true,
			recallBudget: 1200,
			timeoutMs: 1500,
		});
		await setProviderDisabled([]);
		stub.seedMemories("bobbit", [{ text: "Use a feature flag for risky rollouts.", id: "m1" }]);

		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), "hindsight-worker-smoke-"));
		cwds.push(cwd);
		const sessionId = await createSession({ cwd });
		sessionIds.push(sessionId);

		const sessionSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const recalled = await callBeforePrompt(sessionId, "how should this roll out?", sessionSecret);
		expect(recalled.status).toBe(200);
		expect(recalled.content).toContain("source=\"Relevant memory\"");
		expect(recalled.content).toContain("feature flag");
		expect(stub.calls.some((call) => /\/memories\/recall$/.test(call.path) && call.bank === "bobbit")).toBe(true);

		const prompt = "Remember the worker-backed retain path.";
		const retainedBefore = stub.retained("bobbit").length;
		await driveTurn(sessionId, prompt);
		await waitForCondition(
			() => stub.retained("bobbit").length > retainedBefore,
			{ timeoutMs: 10_000, message: "afterTurn retained through the worker store.read proxy" },
		);
	});
});

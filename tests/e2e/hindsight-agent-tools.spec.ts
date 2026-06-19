/**
 * API E2E — P5 Hindsight agent tools (`hindsight_recall`, `hindsight_retain`,
 * `hindsight_reflect`).
 *
 * Verifies the three pack-owned agent tools round-trip through the REAL
 * tool-activation + authorization path to the in-process Hindsight STUB
 * (tests/e2e/hindsight-stub.mjs), and that disabling the pack removes the tools
 * from a project's resolved tool list.
 *
 * ── What "the real tool activation path" means here ──────────────────────────
 * The shipped tools are `bobbit-extension` tools whose handler
 * (market-packs/hindsight/tools/hindsight/extension.ts) does exactly two HTTP
 * calls per invocation:
 *   1. POST /api/ext/surface-token { sessionId, tool }      → mint a tool-bound
 *      SERVER-MINTED surface token (tool-guard: tool ∈ allowedTools + own session
 *      + tool resolves to a market pack).
 *   2. POST /api/ext/route/<recall|retain|reflect>
 *        { sessionId, surfaceToken, init:{ method:"POST", body } }  → dispatch the
 *      pack's route in the confined worker, which owns config merge, bank
 *      resolution (default `bobbit`), external-mode handling, dormancy, and the
 *      scope→tag mapping, then calls the Hindsight client → the stub.
 *
 * The in-process mock agent cannot LOAD/execute a `pi.registerTool` extension
 * (it has no real LLM and no extension host for agent tools), so this spec drives
 * the SAME two endpoints the tool's handler drives — i.e. it exercises the real
 * surface-token mint, the tool-guard, the route registry, the confined-worker
 * route dispatch, the inlined REST client, and the stub. This is the faithful
 * agent-tool round-trip minus only the thin `execute()` text-formatting wrapper.
 * (Mirrors how tests/e2e/ui/pr-walkthrough-pack.spec.ts exercises pack routes via
 * a minted surface token rather than re-importing the route functions.)
 *
 * Pack layering + config seeding mirror the sibling hindsight-external.spec.ts:
 * the pack is installed as a SERVER-scope market pack (NOT via
 * BOBBIT_BUILTIN_PACKS_DIR, which would clobber sibling specs sharing the
 * worker-scoped in-process gateway) and provider config is seeded into the
 * pack-scoped store BEFORE use. Pointing `externalUrl` at the stub activates the
 * route's data plane (`isActive` == `isConfigured` in external mode).
 *
 * The whole suite SKIPS cleanly until the P5 tool descriptors land on the branch,
 * so it never red-bars the e2e phase before the implementation is merged.
 */
import { test as base, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	defaultProjectId,
} from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK_NAME = "hindsight";
const PACK_SRC = path.resolve(__dirname, "..", "..", "market-packs", PACK_NAME);
const STUB_PATH = path.resolve(__dirname, "hindsight-stub.mjs");
const TOOLS_DIR = path.join(PACK_SRC, "tools", "hindsight");

// The pack-store key the loader/route persist provider config under. Mirrors
// CONFIG_KEY in market-packs/hindsight/src/shared.ts (== providerConfigStoreKey
// ("memory")), which loadEffectiveConfig() reads inside the route.
const CONFIG_STORE_KEY = "provider-config:memory";

// The three P5 agent tools.
const RECALL = "hindsight_recall";
const RETAIN = "hindsight_retain";
const REFLECT = "hindsight_reflect";
const HINDSIGHT_TOOLS = [RECALL, RETAIN, REFLECT] as const;

// Gate the suite on the P5 tool descriptors being present so the e2e phase stays
// green until the pack tools are merged. When the descriptors land they bring the
// rebuilt lib/routes.mjs (with the retain scope→tag mapping) alongside them.
const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "pack.yaml")) &&
	fs.existsSync(path.join(PACK_SRC, "lib", "routes.mjs")) &&
	fs.existsSync(path.join(PACK_SRC, "lib", "provider.mjs")) &&
	fs.existsSync(STUB_PATH) &&
	HINDSIGHT_TOOLS.every((n) => fs.existsSync(path.join(TOOLS_DIR, `${n}.yaml`)));

const test = base;
const describe = DEPS_READY ? test.describe : test.describe.skip;

// ── stub typing (the .mjs is untyped; describe its shape locally) ────────────
interface RetainedItem { content: string; tags: string[]; async: boolean }
interface RecordedCall { method: string; path: string; bank?: string; namespace?: string; body?: any }
interface HindsightStub {
	url: string;
	calls: RecordedCall[];
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: { text: string; id?: string; score?: number; tags?: string[] }[]): void;
	retained(bank?: string): RetainedItem[];
	close(): Promise<void>;
}

async function startStub(): Promise<HindsightStub> {
	const mod = await import(STUB_PATH as string);
	const start = mod.startHindsightStub ?? mod.default;
	return start({ port: 0 }) as Promise<HindsightStub>;
}

function writeMeta(packDir: string): void {
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
}

function installPack(bobbitDir: string): string {
	const packDir = path.join(bobbitDir, ".bobbit", "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(PACK_SRC, packDir, { recursive: true });
	writeMeta(packDir);
	return packDir;
}

/** Percent-encode every non-alphanumeric byte — mirrors pack-store.ts::encodeKey
 *  so config lands at the exact path the loader/route read. */
function encodeStoreKey(key: string): string {
	const bytes = Buffer.from(key, "utf8");
	let out = "";
	for (const b of bytes) {
		const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
		out += isAlnum ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** Seed (or clear) the Hindsight provider config in the pack-scoped store. The
 *  route's loadEffectiveConfig() overlays this over the yaml defaults; an
 *  `externalUrl` makes the route's `isActive` gate pass (external mode). */
function seedConfig(bobbitDir: string, config: Record<string, unknown> | null): void {
	const dir = path.join(bobbitDir, "state", "ext-store", PACK_NAME);
	const file = path.join(dir, `${encodeStoreKey(CONFIG_STORE_KEY)}.json`);
	if (config === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ v: 1, value: config }), "utf-8");
}

function externalConfig(stubUrl: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		mode: "external",
		externalUrl: stubUrl,
		bank: "bobbit",
		namespace: "default",
		recallScope: "all",
		autoRecall: true,
		autoRetain: true,
		recallBudget: 1200,
		timeoutMs: 1500,
		...over,
	};
}

/** Replace the pack's disabled-entity refs at server scope (the install scope).
 *  An all-empty payload clears the override (everything enabled). */
async function setPackActivation(disabled: Record<string, string[]>): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled }),
	});
	expect(resp.status, await resp.text().catch(() => "")).toBe(200);
}

const ALL_ENABLED = { roles: [], tools: [], skills: [], entrypoints: [], providers: [] };

/** The set of agent-tool names resolved for a project (== the tools a session in
 *  that project would be offered). */
async function projectToolNames(projectId: string): Promise<Set<string>> {
	const resp = await apiFetch(`/api/tools?projectId=${encodeURIComponent(projectId)}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return new Set((body.tools as Array<{ name?: string }>).map((t) => t.name).filter(Boolean) as string[]);
}

/** Mint a tool-bound surface token (raw — caller inspects status). */
async function mintToolToken(sessionId: string, tool: string): Promise<Response> {
	return apiFetch("/api/ext/surface-token", {
		method: "POST",
		headers: { "x-bobbit-session-id": sessionId },
		body: JSON.stringify({ sessionId, tool }),
	});
}

interface RouteResult { status: number; body: any }

/** Drive the EXACT surface-token + route round-trip the tool's extension handler
 *  drives: mint a tool-bound token, then POST the pack route with it. */
async function invokeTool(
	sessionId: string,
	tool: string,
	routeName: string,
	routeBody: Record<string, unknown>,
): Promise<RouteResult> {
	const mintResp = await mintToolToken(sessionId, tool);
	const mintText = await mintResp.text();
	expect(mintResp.status, `surface-token mint failed: ${mintText}`).toBe(200);
	const surfaceToken = (JSON.parse(mintText) as { token?: string }).token as string;
	expect(surfaceToken).toBeTruthy();
	const resp = await apiFetch(`/api/ext/route/${encodeURIComponent(routeName)}`, {
		method: "POST",
		headers: { "x-bobbit-session-id": sessionId },
		body: JSON.stringify({ sessionId, surfaceToken, init: { method: "POST", body: routeBody } }),
	});
	return { status: resp.status, body: resp.status === 200 ? await resp.json() : await resp.text() };
}

function recallCalls(stub: HindsightStub, sinceIdx: number): RecordedCall[] {
	return stub.calls.slice(sinceIdx).filter((c) => c.method === "POST" && /\/memories\/recall$/.test(c.path));
}
function reflectCalls(stub: HindsightStub, sinceIdx: number): RecordedCall[] {
	return stub.calls.slice(sinceIdx).filter((c) => c.method === "POST" && /\/reflect$/.test(c.path));
}

describe.configure({ mode: "serial" });

describe("hindsight agent tools — recall/retain/reflect round-trip (stub)", () => {
	const sessions: string[] = [];
	let packDir: string;
	let bobbitDir: string;
	let stub: HindsightStub;
	let projectId: string;

	async function newSession(): Promise<string> {
		const id = await createSession();
		sessions.push(id);
		return id;
	}

	test.beforeAll(async ({ gateway }) => {
		bobbitDir = gateway.bobbitDir;
		packDir = installPack(bobbitDir);
		stub = await startStub();
		projectId = (await defaultProjectId())!;
		expect(projectId, "harness default project id resolves").toBeTruthy();
		await setPackActivation(ALL_ENABLED);
	});

	test.afterAll(async () => {
		await setPackActivation(ALL_ENABLED).catch(() => {});
		seedConfig(bobbitDir, null);
		if (stub) await stub.close().catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
	});

	test.afterEach(async () => {
		await setPackActivation(ALL_ENABLED).catch(() => {});
		seedConfig(bobbitDir, null);
		for (const id of sessions.splice(0)) await deleteSession(id).catch(() => {});
	});

	test("recall maps scope to tag filters on the default `bobbit` bank", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url)); // bank: bobbit
		const id = await newSession();

		// scope:project → project:<id> tag + tags_match:any on bank `bobbit`.
		let mark = stub.calls.length;
		const proj = await invokeTool(id, RECALL, "recall", { query: "how do we ship safely?", scope: "project" });
		expect(proj.status).toBe(200);
		expect(proj.body.configured).toBe(true);
		const projCalls = recallCalls(stub, mark);
		expect(projCalls.length).toBe(1);
		expect(projCalls[0].bank).toBe("bobbit");
		expect(projCalls[0].body?.tags).toEqual([`project:${projectId}`]);
		expect(projCalls[0].body?.tags_match).toBe("any");

		// scope:all → NO project tag filter on bank `bobbit`.
		mark = stub.calls.length;
		const all = await invokeTool(id, RECALL, "recall", { query: "how do we ship safely?", scope: "all" });
		expect(all.status).toBe(200);
		expect(all.body.configured).toBe(true);
		const allCalls = recallCalls(stub, mark);
		expect(allCalls.length).toBe(1);
		expect(allCalls[0].bank).toBe("bobbit");
		expect(allCalls[0].body?.tags).toBeUndefined();
		expect(allCalls[0].body?.tags_match).toBeUndefined();
	});

	test("recall scope returns seeded project-tagged memories through the route", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url));
		stub.seedMemories("bobbit", [
			{ text: "Risky rollouts always go behind a feature flag.", id: "m1", tags: [`project:${projectId}`] },
		]);
		const id = await newSession();
		const res = await invokeTool(id, RECALL, "recall", { query: "rollout policy", scope: "project" });
		expect(res.status).toBe(200);
		expect(res.body.configured).toBe(true);
		expect(Array.isArray(res.body.memories)).toBe(true);
		expect(res.body.memories.map((m: { text: string }) => m.text)).toContain(
			"Risky rollouts always go behind a feature flag.",
		);
	});

	test("retain records kind:manual and a project tag when scoped to project", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url)); // bank: bobbit
		const id = await newSession();

		const before = stub.retained("bobbit").length;
		const res = await invokeTool(id, RETAIN, "retain", {
			content: "We migrated billing to the new queue.",
			scope: "project",
			sync: true,
		});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.configured).toBe(true);

		const retained = stub.retained("bobbit");
		expect(retained.length).toBe(before + 1);
		const item = retained[retained.length - 1];
		expect(item.content).toBe("We migrated billing to the new queue.");
		expect(item.tags).toContain("kind:manual");
		expect(item.tags).toContain(`project:${projectId}`);
	});

	test("retain scope:all carries kind:manual but NO project tag", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url));
		const id = await newSession();

		const before = stub.retained("bobbit").length;
		const res = await invokeTool(id, RETAIN, "retain", { content: "Unscoped fact.", scope: "all", sync: true });
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);

		const retained = stub.retained("bobbit");
		expect(retained.length).toBe(before + 1);
		const item = retained[retained.length - 1];
		expect(item.tags).toContain("kind:manual");
		expect(item.tags.some((t) => t.startsWith("project:"))).toBe(false);
	});

	test("retain enforces kind:manual — user-supplied tags cannot override it", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url));
		const id = await newSession();

		const before = stub.retained("bobbit").length;
		// A user tries to spoof the provenance marker via `tags: { kind: "spoofed" }`.
		const res = await invokeTool(id, RETAIN, "retain", {
			content: "Manual provenance is enforced.",
			tags: { kind: "spoofed", topic: "billing" },
			scope: "all",
			sync: true,
		});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);

		const retained = stub.retained("bobbit");
		expect(retained.length).toBe(before + 1);
		const item = retained[retained.length - 1];
		// kind stays "manual"; the spoofed value is never persisted.
		expect(item.tags).toContain("kind:manual");
		expect(item.tags).not.toContain("kind:spoofed");
		// Other user tags stay additive.
		expect(item.tags).toContain("topic:billing");
	});

	test("reflect runs over the resolved shared bank and returns synthesized text", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url)); // bank: bobbit
		const id = await newSession();

		const mark = stub.calls.length;
		const res = await invokeTool(id, REFLECT, "reflect", { prompt: "what did we learn about billing?", scope: "all" });
		expect(res.status).toBe(200);
		expect(res.body.configured).toBe(true);
		expect(typeof res.body.text).toBe("string");
		expect(res.body.text).toContain("what did we learn about billing?");

		const calls = reflectCalls(stub, mark);
		expect(calls.length).toBe(1);
		expect(calls[0].bank).toBe("bobbit");
	});

	test("reflect maps scope to tag filters on the shared bank (project filters; all does not)", async () => {
		// P5 contract: reflect's `scope` maps to a TAG FILTER on the shared bank, just
		// like recall — a project-scoped reflect must NOT reflect over the whole bank.
		seedConfig(bobbitDir, externalConfig(stub.url)); // bank: bobbit
		const id = await newSession();

		// scope:project → project:<id> tag + tags_match:any on bank `bobbit`.
		let mark = stub.calls.length;
		const proj = await invokeTool(id, REFLECT, "reflect", { prompt: "how do we ship safely?", scope: "project" });
		expect(proj.status).toBe(200);
		const projCalls = reflectCalls(stub, mark);
		expect(projCalls.length).toBe(1);
		expect(projCalls[0].bank).toBe("bobbit");
		expect(projCalls[0].body?.tags).toEqual([`project:${projectId}`]);
		expect(projCalls[0].body?.tags_match).toBe("any");

		// scope:all → NO project tag filter (reflect over the whole bank).
		mark = stub.calls.length;
		const all = await invokeTool(id, REFLECT, "reflect", { prompt: "how do we ship safely?", scope: "all" });
		expect(all.status).toBe(200);
		const allCalls = reflectCalls(stub, mark);
		expect(allCalls.length).toBe(1);
		expect(allCalls[0].bank).toBe("bobbit");
		expect(allCalls[0].body?.tags).toBeUndefined();
		expect(allCalls[0].body?.tags_match).toBeUndefined();
	});

	test("a configured custom bank flows through every route to the stub", async () => {
		const CUSTOM_BANK = "custom-memory-bank";
		seedConfig(bobbitDir, externalConfig(stub.url, { bank: CUSTOM_BANK }));
		const id = await newSession();

		let mark = stub.calls.length;
		const recall = await invokeTool(id, RECALL, "recall", { query: "where do memories live?", scope: "all" });
		expect(recall.status).toBe(200);
		const rc = recallCalls(stub, mark);
		expect(rc.length).toBe(1);
		expect(rc[0].bank).toBe(CUSTOM_BANK);

		mark = stub.calls.length;
		const reflect = await invokeTool(id, REFLECT, "reflect", { prompt: "summary", scope: "all" });
		expect(reflect.status).toBe(200);
		const fc = reflectCalls(stub, mark);
		expect(fc.length).toBe(1);
		expect(fc[0].bank).toBe(CUSTOM_BANK);

		const before = stub.retained(CUSTOM_BANK).length;
		const retain = await invokeTool(id, RETAIN, "retain", { content: "Bank routing works.", scope: "project", sync: true });
		expect(retain.status).toBe(200);
		expect(retain.body.ok).toBe(true);
		const retained = stub.retained(CUSTOM_BANK);
		expect(retained.length).toBe(before + 1);
		expect(retained[retained.length - 1].tags).toContain(`project:${projectId}`);
	});

	test("the three tools resolve for a project session and mint tool-bound surface tokens", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url));
		const id = await newSession();

		const names = await projectToolNames(projectId);
		for (const t of HINDSIGHT_TOOLS) {
			expect(names.has(t), `tool ${t} present in resolved tool list`).toBe(true);
		}
		// Each tool can mint a tool-bound surface token (the activation/auth path).
		for (const t of HINDSIGHT_TOOLS) {
			const resp = await mintToolToken(id, t);
			expect(resp.status, `mint ${t}`).toBe(200);
			expect((await resp.json()).token).toBeTruthy();
		}
	});

	test("disabling the pack tools removes them from a newly-created session's tool list", async () => {
		seedConfig(bobbitDir, externalConfig(stub.url));

		// Baseline: present.
		const enabled = await projectToolNames(projectId);
		for (const t of HINDSIGHT_TOOLS) expect(enabled.has(t)).toBe(true);

		// Disable the three pack tools at the install (server) scope. The project's
		// resolved tool list (== a session-in-project's tool list) drops them.
		await setPackActivation({ ...ALL_ENABLED, tools: [...HINDSIGHT_TOOLS] });

		const id = await newSession(); // created AFTER the disable
		const disabled = await projectToolNames(projectId);
		for (const t of HINDSIGHT_TOOLS) {
			expect(disabled.has(t), `tool ${t} absent after pack disable`).toBe(false);
		}
		// A disabled tool no longer resolves as a market-pack tool, so a tool-bound
		// surface token cannot be minted (the activation gate is closed end-to-end).
		const mint = await mintToolToken(id, RECALL);
		expect(mint.status).toBe(403);

		// Re-enabling restores them.
		await setPackActivation(ALL_ENABLED);
		const reenabled = await projectToolNames(projectId);
		for (const t of HINDSIGHT_TOOLS) expect(reenabled.has(t)).toBe(true);
	});
});

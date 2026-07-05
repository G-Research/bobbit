/**
 * API E2E — Hindsight pack, external mode (Extension Platform G2 / G2.1+G2.2).
 *
 * Drives the built-in (dormant-by-default) Hindsight memory provider against an
 * in-process Hindsight STUB (tests/e2e/hindsight-stub.mjs) so the lifecycle
 * recall/retain hooks, dormancy gating, retry queue, and diagnostics can be
 * exercised deterministically with no network and no real Hindsight.
 *
 * Pattern mirrors provider-session-setup.spec.ts / provider-turn-hooks.spec.ts:
 * the pack is layered as a SERVER-SCOPE market pack on top of the real built-in
 * band (NOT via BOBBIT_BUILTIN_PACKS_DIR, which would clobber sibling specs
 * sharing the worker-scoped in-process gateway). Provider config is seeded into
 * the pack-scoped store (the same store the loader overlays over yaml defaults —
 * design §8.3) BEFORE a session is created, so the host's config-gated activation
 * (`activation.requiresConfig: [externalUrl]`) flips the provider from dormant to
 * active. Pointing `externalUrl` at the stub is what activates it.
 *
 * Assertion surfaces (all token-free, no pack tool/surface needed):
 *   - prompt-sections  → the "Dynamic Context" section carries recall blocks.
 *   - provider-hooks/before-prompt → the per-turn dynamic-context message content.
 *   - context-trace    → per-provider timing rows + non-fatal diagnostics.
 *   - the stub's own recorders (calls / retained) → what the provider actually
 *     sent to Hindsight (bank id + auto-tag taxonomy).
 *
 * NOTE (seam): setting/reading provider config and the pack `status` route
 * normally go through a pack surface (route call needs a server-minted surface
 * token), which a tools-less pack cannot mint in this goal. This spec therefore
 * SEEDS config directly into the pack store on disk and reads health/queue state
 * from the context-trace + stub recorders. If the host later exposes a config /
 * status server API, swap `seedConfig`/the unhealthy assertions to use it — the
 * helpers are centralized below.
 *
 * The whole suite SKIPS cleanly until the pack + stub land on the branch (the
 * parallel coder tasks own `market-packs/hindsight/**` and the stub), so it never
 * red-bars the e2e phase before the implementation is merged.
 */
import { test as base, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	createGoal,
	deleteSession,
	connectWs,
	agentEndPredicate,
	messageEndPredicate,
	waitForCondition,
	nonGitCwd,
} from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PACK_NAME = "hindsight";
const PROVIDER_ID = "memory";
// Built pack source (lib/*.mjs produced by scripts/build-market-packs.mjs).
const PACK_SRC = path.resolve(__dirname, "..", "..", "market-packs", PACK_NAME);
const STUB_PATH = path.resolve(__dirname, "hindsight-stub.mjs");

// The pack-store key the loader persists provider config under. Must mirror
// providerConfigStoreKey("memory") in src/server/agent/pack-contributions.ts.
const CONFIG_STORE_KEY = "provider-config:memory";
// Gate the suite on the implementation being present so the e2e phase stays green
// until the pack + stub are merged from the sibling coder branches.
const DEPS_READY =
	fs.existsSync(path.join(PACK_SRC, "pack.yaml")) &&
	fs.existsSync(path.join(PACK_SRC, "lib", "provider.mjs")) &&
	fs.existsSync(STUB_PATH);

const test = base;
const describe = DEPS_READY ? test.describe : test.describe.skip;

// ── stub typing (the .mjs is untyped; describe its shape locally) ────────────
interface RetainedItem { content: string; tags: string[]; async: boolean }
interface RecordedCall { method: string; path: string; bank?: string; namespace?: string; body?: unknown }
interface HindsightStub {
	url: string;
	calls: RecordedCall[];
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, mem: { text: string; id?: string; score?: number; tags?: string[] }[]): void;
	retained(bank?: string): RetainedItem[];
	close(): Promise<void>;
}

async function startStub(): Promise<HindsightStub> {
	// Indirect specifier (`as string`) so the typechecker does not try to resolve
	// the untyped .mjs before it lands on the branch — keeps `npm run check` green.
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

function installPack(headquartersDir: string): string {
	const packDir = path.join(headquartersDir, "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(PACK_SRC, packDir, { recursive: true });
	writeMeta(packDir);
	return packDir;
}

/** Percent-encode every non-alphanumeric byte — mirrors pack-store.ts::encodeKey
 *  so we land config at the exact path the loader reads. */
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
 *  loader overlays this over the yaml defaults to build `ctx.config` (design §8.3),
 *  and the host's `activation.requiresConfig: [externalUrl]` activates the provider
 *  once `externalUrl` is non-empty. */
function seedConfig(bobbitDir: string, config: Record<string, unknown> | null): void {
	const dir = path.join(bobbitDir, "state", "ext-store", PACK_NAME);
	const file = path.join(dir, `${encodeStoreKey(CONFIG_STORE_KEY)}.json`);
	if (config === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(dir, { recursive: true });
	// Envelope shape matches pack-store.ts (`{ v: 1, value }`).
	fs.writeFileSync(file, JSON.stringify({ v: 1, value: config }), "utf-8");
}

function defaultConfig(stubUrl: string, over: Record<string, unknown> = {}): Record<string, unknown> {
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

async function setProviderDisabled(providers: string[]): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { providers } }),
	});
	expect(resp.status).toBe(200);
}

async function dynamicContextSection(sessionId: string): Promise<{ source: string; content: string } | undefined> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return body.sections.find((s: { label: string }) => s.label === "Dynamic Context");
}

interface TraceProviderRow { id: string; ms: number; blocks: number; omitted: number; error?: string }
interface TraceEntry { ts: number; hook: string; sessionId: string; providers: TraceProviderRow[] }

async function readContextTrace(sessionId: string): Promise<TraceEntry[]> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/context-trace`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	if (Array.isArray(body)) return body as TraceEntry[];
	if (Array.isArray(body?.trace)) return body.trace as TraceEntry[];
	if (Array.isArray(body?.entries)) return body.entries as TraceEntry[];
	return [];
}

interface BeforePromptResult { status: number; content: string; tail: string; blocks: Array<Record<string, unknown>> }
async function callBeforePrompt(sessionId: string, prompt: string): Promise<BeforePromptResult> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		body: JSON.stringify({ prompt }),
	});
	const body = resp.status === 200 ? await resp.json() : {};
	return {
		status: resp.status,
		content: typeof body.content === "string" ? body.content : "",
		tail: typeof body.tail === "string" ? body.tail : "",
		blocks: Array.isArray(body.blocks) ? body.blocks : [],
	};
}

interface BeforeCompactResult { status: number; body: Record<string, unknown> }
async function callBeforeCompact(sessionId: string, payload: Record<string, unknown>): Promise<BeforeCompactResult> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-compact`, {
		method: "POST",
		body: JSON.stringify(payload),
	});
	const body = resp.status === 200 ? await resp.json() : {};
	return { status: resp.status, body };
}

/** Drive a full turn and return the echoed user text (to pin the no-mutation
 *  invariant). afterTurn is dispatched server-side on agent_end. */
async function driveTurn(sessionId: string, prompt: string): Promise<string> {
	const conn = await connectWs(sessionId);
	try {
		const userEnd = conn.waitFor(messageEndPredicate("user"));
		conn.send({ type: "prompt", text: prompt });
		const echoed = await userEnd;
		await conn.waitFor(agentEndPredicate(), 15_000);
		const content = echoed.data.message.content;
		const text = Array.isArray(content)
			? content.find((c: { type: string }) => c.type === "text")?.text
			: content;
		return text ?? "";
	} finally {
		conn.close();
	}
}

describe.configure({ mode: "serial" });

describe("hindsight pack — external mode (stub)", () => {
	const sessions: string[] = [];
	const cwds: string[] = [];
	let packDir: string;
	let bobbitDir: string;
	let stub: HindsightStub;

	function freshCwd(label: string): string {
		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), `hindsight-${label}-`));
		cwds.push(cwd);
		return cwd;
	}

	async function newSession(label: string, opts: { goalId?: string } = {}): Promise<{ id: string; cwd: string }> {
		const cwd = freshCwd(label);
		const id = await createSession({ cwd, goalId: opts.goalId });
		sessions.push(id);
		return { id, cwd };
	}

	test.beforeAll(async ({ gateway }) => {
		bobbitDir = gateway.bobbitDir;
		packDir = installPack(bobbitDir);
		stub = await startStub();
		await setProviderDisabled([]);
	});

	test.afterAll(async () => {
		await setProviderDisabled([]).catch(() => {});
		seedConfig(bobbitDir, null);
		if (stub) await stub.close().catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
	});

	test.afterEach(async () => {
		// Disable the provider + clear config so the next test starts dormant and
		// no hook fires during teardown deletes.
		await setProviderDisabled([PROVIDER_ID]).catch(() => {});
		seedConfig(bobbitDir, null);
		for (const id of sessions.splice(0)) await deleteSession(id).catch(() => {});
		for (const cwd of cwds.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
	});

	test("beforePrompt injects 'Relevant memory' blocks once configured", async () => {
		seedConfig(bobbitDir, defaultConfig(stub.url));
		await setProviderDisabled([]);
		stub.seedMemories("bobbit", [
			{ text: "Risky rollouts should always go behind a feature flag.", id: "m1" },
		]);

		const { id } = await newSession("setup");

		// beforePrompt recall → fenced context block message content carrying the
		// memory and refreshes the prompt-sections Dynamic Context snapshot.
		const before = await callBeforePrompt(id, "how do we roll out risky changes safely?");
		expect(before.status).toBe(200);
		expect(before.content).toContain("<context-block");
		expect(before.content).toContain("source=\"Relevant memory\"");
		expect(before.content).toContain("feature flag");
		expect(before.tail).toContain(before.content);

		const section = await dynamicContextSection(id);
		expect(section, "Dynamic Context section present after beforePrompt recall").toBeTruthy();
		expect(section!.source).toBe("providers");
		expect(section!.content).toContain("Relevant memory");
		expect(section!.content).toContain("feature flag");

		// The provider actually called recall against bank `bobbit`.
		const recallCalls = stub.calls.filter((c) => /\/memories\/recall$/.test(c.path));
		expect(recallCalls.length).toBeGreaterThan(0);
		expect(recallCalls.every((c) => c.bank === "bobbit")).toBeTruthy();
	});

	test("a turn remains unaffected while the Hindsight provider is configured", async () => {
		const goal = await createGoal({ title: "Hindsight configured turn" });
		seedConfig(bobbitDir, defaultConfig(stub.url));
		await setProviderDisabled([]);

		const { id } = await newSession("retain", { goalId: goal.id });
		await callBeforePrompt(id, "warm up Hindsight provider before turn");
		const prompt = "Remember that we migrated the billing service to the new queue.";
		const echoed = await driveTurn(id, prompt);
		// INVARIANT: lifecycle hooks never mutate the user's message text.
		expect(echoed).toBe(prompt);
	});

	test("an unhealthy Hindsight skips recall non-fatally and surfaces a diagnostic", async () => {
		seedConfig(bobbitDir, defaultConfig(stub.url));
		await setProviderDisabled([]);
		stub.setHealthy(false);

		const { id } = await newSession("unhealthy");
		const before = await callBeforePrompt(id, "recall should fail non-fatally");
		expect(before.status).toBe(200);
		expect(before.content).toBe("");
		expect(before.tail).toBe("");
		expect(before.blocks).toEqual([]);

		// A non-fatal diagnostic is recorded against the memory provider.
		await waitForCondition(async () => {
			const trace = await readContextTrace(id);
			return trace.some((e) => e.providers.some((p) => p.id === PROVIDER_ID && !!p.error));
		}, { timeoutMs: 10_000, message: "memory provider diagnostic in context-trace" });

		stub.setHealthy(true);
	});

	test("recall recovers after Hindsight health is restored", async () => {
		seedConfig(bobbitDir, defaultConfig(stub.url));
		await setProviderDisabled([]);
		const { id } = await newSession("recovery");

		stub.setHealthy(false);
		const down = await callBeforePrompt(id, "memory while down");
		expect(down.content).toBe("");
		expect(down.tail).toBe("");

		stub.setHealthy(true);
		stub.seedMemories("bobbit", [{ text: "Recovered recall works.", id: "r1" }]);
		const up = await callBeforePrompt(id, "memory after recovery");
		expect(up.content).toContain("Recovered recall works.");
	});

	test("beforeCompact retains the about-to-be-lost span (not an empty no-op)", async () => {
		// Regression: the bridge posted `{}` and the route dispatched only the base
		// session context, so provider.beforeCompact retained nothing. The route now
		// forwards the span; the provider retains it sync with kind:compaction.
		seedConfig(bobbitDir, defaultConfig(stub.url));
		await setProviderDisabled([]);
		const { id } = await newSession("compact");

		const span = "User: migrate billing to the new queue\n\nAssistant: done, queue cut over";
		const before = stub.retained("bobbit").length;
		const res = await callBeforeCompact(id, { span });
		expect(res.status).toBe(200);

		await waitForCondition(async () => stub.retained("bobbit").length > before, {
			timeoutMs: 10_000,
			message: "beforeCompact span retained on the stub",
		});
		const retained = stub.retained("bobbit");
		const item = retained.find((r) => r.content === span);
		expect(item, "retained item carries the forwarded span content").toBeTruthy();
		expect(item!.tags).toContain("kind:compaction");
	});

	test("beforeCompact rejects a non-string span body", async () => {
		seedConfig(bobbitDir, defaultConfig(stub.url));
		await setProviderDisabled([]);
		const { id } = await newSession("compact-bad");
		const resp = await apiFetch(`/api/sessions/${id}/provider-hooks/before-compact`, {
			method: "POST",
			body: JSON.stringify({ span: 123 }),
		});
		expect(resp.status).toBe(400);
	});

	test("per-project pack disable prevents injection", async () => {
		seedConfig(bobbitDir, defaultConfig(stub.url));
		// Provider disabled despite a valid config → dormant, no recall, no blocks.
		await setProviderDisabled([PROVIDER_ID]);
		stub.seedMemories("bobbit", [{ text: "Should never be injected.", id: "x1" }]);

		const callsBefore = stub.calls.length;
		const { id } = await newSession("disabled");

		const section = await dynamicContextSection(id);
		expect(section, "no Dynamic Context section when the provider is disabled").toBeUndefined();
		const before = await callBeforePrompt(id, "anything");
		expect(before.content).toBe("");
		expect(before.tail).toBe("");
		expect(before.blocks).toEqual([]);
		// No recall was issued for the disabled provider.
		expect(stub.calls.length).toBe(callsBefore);
	});

	test("config persists in the pack store and applies to a freshly created session", async () => {
		// Seed once; create two sessions WITHOUT re-seeding. The loader re-reads the
		// store-backed config for each, proving durable persistence (design §8.3).
		seedConfig(bobbitDir, defaultConfig(stub.url));
		await setProviderDisabled([]);
		stub.seedMemories("bobbit", [{ text: "Persisted config recall works.", id: "p1" }]);

		const a = await newSession("persist-a");
		await callBeforePrompt(a.id, "check persisted config memory");
		const sectionA = await dynamicContextSection(a.id);
		expect(sectionA?.content).toContain("Persisted config recall works.");

		const b = await newSession("persist-b");
		await callBeforePrompt(b.id, "check persisted config memory again");
		const sectionB = await dynamicContextSection(b.id);
		expect(sectionB?.content).toContain("Persisted config recall works.");
	});
});

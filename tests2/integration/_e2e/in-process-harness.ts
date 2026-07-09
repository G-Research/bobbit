/**
 * Compatibility shim: reproduces the Playwright-flavoured `test` / `expect`
 * surface of tests/e2e/in-process-harness.ts on top of vitest, so migrated
 * v2-integration specs keep their `test.describe` / `test.beforeAll` /
 * `test("…", async ({ gateway }) => …)` structure unchanged.
 *
 * Instead of a per-worker Playwright fixture, `gateway` is the fork-scoped
 * singleton from tests2/harness/gateway.ts (booted once per fork). Each
 * `test.describe` block is automatically wrapped with:
 *   - a per-describe entity-leak guard (snapshot at describe start, assert at
 *     describe end — runs AFTER the spec's own afterAll cleanup); and
 *   - a per-test scope() so entities created via the e2e-setup helpers are
 *     cleaned up as a safety net even if a test forgets.
 *
 * This keeps the shared fork clean (R2 mitigation) without editing spec bodies.
 */
// The fork gateway freezes `skipLlmReview` at boot from process.env (server.ts
// reads resolveLegacyTestRuntimeFlags() directly). Set it before the singleton
// boot so llm-review / agent-qa / human-signoff verification steps auto-pass in
// tier-1 (they have no reviewer sub-agent). NOTE: for full determinism the
// gateway fixture itself should set this before boot — see the escalation note
// in the migration report; this import-time set is a transitional belt.
process.env.BOBBIT_LLM_REVIEW_SKIP ??= "1";
process.env.BOBBIT_HUMAN_SIGNOFF_SKIP ??= "1";

import {
	afterAll as vAfterAll,
	afterEach as vAfterEach,
	beforeAll as vBeforeAll,
	beforeEach as vBeforeEach,
	describe as vDescribe,
	it as vIt,
	expect as vExpect,
} from "vitest";
import { type EntityCounts, type GatewayFixture } from "../../harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../../harness/leak-detector.js";
import { createScope, type TestScope } from "../../harness/scope.js";
import { currentScope, ensureGateway, gatewaySync, setScope } from "./runtime.js";

// Playwright's retrying `await expect(fn).toPass({ timeout })` matcher — vitest
// has no built-in equivalent. The received is a function containing assertions
// that throw until they pass.
vExpect.extend({
	async toPass(received: unknown, opts?: { timeout?: number; intervals?: number[] }) {
		const timeout = opts?.timeout ?? 5_000;
		const start = Date.now();
		let lastErr: unknown;
		const fn = received as () => unknown | Promise<unknown>;
		for (;;) {
			try { await fn(); return { pass: true, message: () => "expected callback not to pass" }; }
			catch (err) {
				lastErr = err;
				if (Date.now() - start > timeout) {
					return { pass: false, message: () => `expected callback to pass within ${timeout}ms; last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` };
				}
				await new Promise(r => setTimeout(r, 100));
			}
		}
	},
});

export const expect = vExpect;
export { currentScope };

// ---------------------------------------------------------------------------
// Global fetch patch: mirror tests/e2e/in-process-harness.ts so RAW `fetch`
// calls to Headquarters-discovery config routes (/api/tools, /api/roles, …)
// carry `projectId=headquarters`. Specs that define their own local `apiFetch`
// (not the compat one) hit these routes via bare fetch and would otherwise 400
// with PROJECT_ID_REQUIRED. Idempotent via a global symbol.
// ---------------------------------------------------------------------------
function needsHeadquartersConfigProjectId(path: string, method: string): boolean {
	const bare = path.split("?")[0];
	if (method === "GET" && /^\/api\/(tools|roles)(\?|$)/.test(path)) return true;
	if ((method === "GET" || method === "PUT") && /^\/api\/tools\/[^/]+$/.test(bare)) return true;
	if (method === "GET" && /^\/api\/tools\/[^/]+\/renderer$/.test(bare)) return true;
	if (method === "GET" && bare === "/api/ext/contributions") return true;
	if (method === "GET" && /^\/api\/ext\/packs\/[^/]+\/panels\/[^/]+$/.test(bare)) return true;
	if ((method === "POST" || method === "DELETE") && /^\/api\/tools\/[^/]+\/(customize|override)$/.test(bare)) return true;
	if (method === "POST" && /^\/api\/roles$/.test(bare)) return true;
	if ((method === "GET" || method === "PUT" || method === "DELETE") && /^\/api\/roles\/(?!assistant\/prompts(?:\/|$))[^/]+$/.test(bare)) return true;
	if ((method === "POST" || method === "DELETE") && /^\/api\/roles\/[^/]+\/(customize|override)$/.test(bare)) return true;
	if (method === "GET" && bare === "/api/tool-group-policies") return true;
	if (method === "PUT" && /^\/api\/tool-group-policies\/[^/]+$/.test(bare)) return true;
	return false;
}
function injectHeadquartersDiscoveryProjectId(path: string, method: string): string {
	if (!needsHeadquartersConfigProjectId(path, method)) return path;
	if (/[?&]projectId=/.test(path)) return path;
	return path + (path.includes("?") ? "&" : "?") + "projectId=headquarters";
}
function injectHeadquartersDiscoveryUrl(input: RequestInfo | URL, init?: RequestInit): RequestInfo | URL {
	const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
	// rawApiFetch deliberately exercises missing-projectId guard paths.
	if ((new Error().stack || "").includes("rawApiFetch")) return input;
	const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	let parsed: URL;
	try { parsed = new URL(value); } catch { return input; }
	const nextPath = injectHeadquartersDiscoveryProjectId(`${parsed.pathname}${parsed.search}`, method);
	if (nextPath === `${parsed.pathname}${parsed.search}`) return input;
	parsed.pathname = nextPath.split("?")[0] || parsed.pathname;
	parsed.search = nextPath.includes("?") ? nextPath.slice(nextPath.indexOf("?")) : "";
	if (typeof input === "string") return parsed.href;
	if (input instanceof URL) return parsed;
	return new Request(parsed.href, input);
}
const FETCH_PATCH_KEY = Symbol.for("bobbit.tests2.discoveryProjectIdFetchPatch");
const globalWithPatch = globalThis as typeof globalThis & { [FETCH_PATCH_KEY]?: true };
if (!globalWithPatch[FETCH_PATCH_KEY]) {
	const originalFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => originalFetch(injectHeadquartersDiscoveryUrl(input, init), init)) as typeof fetch;
	globalWithPatch[FETCH_PATCH_KEY] = true;
}

async function ensureGw(): Promise<GatewayFixture> { return ensureGateway(); }

export interface CompatFixtures {
	gateway: GatewayFixture;
	/** Legacy auto-fixture; restoring the default project is handled by scope cleanup. */
	restoreDefaultProject: void;
	/** The per-test cleanup scope (extra convenience — legacy specs ignore it). */
	scope: TestScope;
}

type TestFn = (fx: CompatFixtures) => void | Promise<void>;
type HookFn = (fx: CompatFixtures) => void | Promise<void>;

function fixtures(): CompatFixtures {
	const gw = gatewaySync();
	return { gateway: gw, restoreDefaultProject: undefined as unknown as void, scope: currentScope() ?? createScope(gw) };
}

function wrapTest(fn?: TestFn): () => Promise<void> {
	return async () => {
		const gw = await ensureGw();
		// When invoked inside a wrapDescribe block, that block owns the scope +
		// sweep. A bare top-level test() (no describe) owns its own sweep here.
		const ownScope = !currentScope();
		const baseline = ownScope ? snapshotIds(gw) : undefined;
		if (ownScope) setScope(createScope(gw));
		try {
			if (fn) await fn(fixtures());
		} finally {
			if (ownScope) {
				setScope(undefined);
				if (baseline) await sweepTo(gw, baseline);
			}
		}
	};
}

function wrapHook(fn?: HookFn): () => Promise<void> {
	return async () => {
		await ensureGw();
		if (fn) await fn(fixtures());
	};
}

interface DescribeBody { (): void }

interface IdSnapshot { sessions: Set<string>; goals: Set<string>; projects: Set<string> }

/**
 * Live entity IDs, sourced from the SAME managers countEntities()/the leak
 * detector read (non-archived goals only). Used to sweep-delete whatever a test
 * created regardless of how it created it (compat helper OR a spec-local
 * apiFetch), so a spec whose own cleanup forgets `cascade` can't poison the fork.
 */
function snapshotIds(gw: GatewayFixture): IdSnapshot {
	const ids: IdSnapshot = { sessions: new Set(), goals: new Set(), projects: new Set() };
	try { for (const s of (gw.sessionManager.listSessions?.() ?? [])) if (s?.id) ids.sessions.add(s.id); } catch { /* */ }
	try {
		for (const ctx of Array.from(gw.projectContextManager.visible?.() ?? []) as any[]) {
			const pid = ctx?.project?.id ?? ctx?.projectId;
			if (pid) ids.projects.add(pid);
			for (const g of (ctx.goalStore?.getAll?.() ?? [])) if (g?.id && !g.archived) ids.goals.add(g.id);
		}
	} catch { /* */ }
	return ids;
}

function hasVisibleDefaultProject(gw: GatewayFixture): boolean {
	try {
		for (const ctx of Array.from(gw.projectContextManager.visible?.() ?? []) as any[]) {
			const proj = ctx?.project;
			if (proj && !proj.hidden && proj.name === "default") return true;
		}
	} catch { /* */ }
	return false;
}

async function sweepTo(gw: GatewayFixture, baseline: IdSnapshot): Promise<void> {
	const now = snapshotIds(gw);
	for (const id of now.sessions) if (!baseline.sessions.has(id)) {
		await gw.api(`/api/sessions/${id}?purge=true`, { method: "DELETE" }).catch(() => {});
	}
	for (const id of now.goals) if (!baseline.goals.has(id)) {
		await gw.api(`/api/goals/${id}?cascade=true`, { method: "DELETE" }).catch(() => {});
	}
	for (const id of now.projects) if (!baseline.projects.has(id) && id !== gw.defaultProjectId) {
		await gw.api(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
	}
	// Heal the default project on cleanup:
	//   - MISSING (a test deleted it) → re-register + reseed via restoreDefaultProject().
	//   - PRESENT but its seeded workflows/component config were mutated in place by a
	//     fork-mate (e.g. inline-workflow-goal-flow.test.ts REPLACES the default
	//     project.yaml workflows) → resetDefaultProjectBaseline() restores the seeded
	//     baseline (no-op when intact). Without the reset branch, a corrupted-but-
	//     present default leaks across the shared fork and flakes later tests that
	//     read the seeded workflows/components (e.g. the QA tooltip metadata test).
	// Neither path touches ctx.workflowStore, so workflows a test registered via
	// POST /api/workflows (a separate store) are preserved.
	if (!hasVisibleDefaultProject(gw)) await gw.restoreDefaultProject();
	else await gw.resetDefaultProjectBaseline();
}

function wrapDescribe(name: string, body: DescribeBody): void {
	vDescribe(name, () => {
		let before: EntityCounts;
		let fileBaseline: IdSnapshot;
		let testBaseline: IdSnapshot;
		// Registered BEFORE the spec's own hooks → beforeAll/beforeEach run first,
		// afterEach/afterAll run last (vitest reverses teardown order), so the
		// sweep + leak assert happen AFTER the spec's own cleanup hooks.
		vBeforeAll(async () => { const gw = await ensureGw(); before = snapshotEntities(gw); fileBaseline = snapshotIds(gw); });
		vBeforeEach(async () => { const gw = await ensureGw(); testBaseline = snapshotIds(gw); setScope(createScope(gw)); });
		vAfterEach(async () => { setScope(undefined); await sweepTo(await ensureGw(), testBaseline); });
		vAfterAll(async () => { const gw = await ensureGw(); await sweepTo(gw, fileBaseline); assertNoLeaks(before, snapshotEntities(gw)); });
		body();
	});
}

interface CompatTest {
	(name: string, fn?: TestFn): void;
	(name: string, opts: unknown, fn?: TestFn): void;
	only: (name: string, fn?: TestFn) => void;
	skip: ((name: string, fn?: TestFn) => void) & (() => void);
	fixme: (name: string, fn?: TestFn) => void;
	describe: {
		(name: string, body: DescribeBody): void;
		serial: (name: string, body: DescribeBody) => void;
		parallel: (name: string, body: DescribeBody) => void;
		only: (name: string, body: DescribeBody) => void;
		skip: ((name: string, body: DescribeBody) => void) & { configure: (opts?: unknown) => void; serial: (name: string, body: DescribeBody) => void };
		configure: (opts?: unknown) => void;
	};
	beforeAll: (fn?: HookFn) => void;
	afterAll: (fn?: HookFn) => void;
	beforeEach: (fn?: HookFn) => void;
	afterEach: (fn?: HookFn) => void;
	use: (opts?: unknown) => void;
	step: (name: string, fn: () => unknown) => Promise<unknown>;
	slow: () => void;
	setTimeout: (ms: number) => void;
	fail: () => void;
}

function pickFn(a?: unknown, b?: unknown): TestFn | undefined {
	if (typeof a === "function") return a as TestFn;
	if (typeof b === "function") return b as TestFn;
	return undefined;
}

const testImpl = ((name: string, a?: unknown, b?: unknown) => {
	vIt(name, wrapTest(pickFn(a, b)));
}) as CompatTest;

testImpl.only = (name, fn) => { (vIt as any).only(name, wrapTest(fn)); };
testImpl.skip = ((name?: string, fn?: TestFn) => {
	// test.skip("name", fn) → skipped test. test.skip() inside a body → best-effort no-op.
	if (typeof name === "string") (vIt as any).skip(name, wrapTest(fn));
}) as CompatTest["skip"];
testImpl.fixme = (name, fn) => { (vIt as any).skip(name, wrapTest(fn)); };

const describeImpl = ((name: string, body: DescribeBody) => wrapDescribe(name, body)) as CompatTest["describe"];
describeImpl.serial = (name, body) => wrapDescribe(name, body);
describeImpl.parallel = (name, body) => wrapDescribe(name, body);
describeImpl.only = (name, body) => { (vDescribe as any).only(name, () => wrapDescribe(name, body)); };
const describeSkip = ((name: string, body: DescribeBody) => { (vDescribe as any).skip(name, body); }) as CompatTest["describe"]["skip"] & { configure: (o?: unknown) => void; serial: (n: string, b: DescribeBody) => void };
describeSkip.configure = () => { /* no-op */ };
describeSkip.serial = (name: string, body: DescribeBody) => { (vDescribe as any).skip(name, body); };
describeImpl.skip = describeSkip;
(describeImpl.serial as any).skip = describeSkip;
describeImpl.configure = () => { /* no-op: vitest handles concurrency via config */ };
testImpl.describe = describeImpl;

testImpl.beforeAll = (fn) => { vBeforeAll(wrapHook(fn)); };
testImpl.afterAll = (fn) => { vAfterAll(wrapHook(fn)); };
testImpl.beforeEach = (fn) => { vBeforeEach(wrapHook(fn)); };
testImpl.afterEach = (fn) => { vAfterEach(wrapHook(fn)); };
testImpl.use = () => { /* worker-option opt-ins (e.g. enableWorktreePool) are not supported in tier-1 */ };
testImpl.step = async (_name, fn) => fn();
testImpl.slow = () => { /* no-op */ };
testImpl.setTimeout = () => { /* per-test timeout governed by vitest config */ };
testImpl.fail = () => { /* no-op */ };

export const test = testImpl;

// Re-export snapshot util for specs that used it directly (rare).
export { snapshotEntities };

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

import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
		const baseline = ownScope ? snapshotCleanupState(gw) : undefined;
		if (ownScope) setScope(createScope(gw));
		try {
			if (fn) await fn(fixtures());
		} finally {
			if (ownScope) {
				setScope(undefined);
				if (baseline) await cleanupTo(gw, baseline);
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

interface CleanupSnapshot {
	ids: IdSnapshot;
	counts: EntityCounts;
	defaultProjectFingerprint: string;
	generation: number;
}

export interface CleanupStats {
	snapshots: number;
	sweeps: number;
	skippedSweeps: number;
	defaultResets: number;
	defaultRestores: number;
	deletedSessions: number;
	deletedGoals: number;
	deletedProjects: number;
}

interface IntegrationHarnessState {
	generation: number;
	stats: CleanupStats;
}

const HARNESS_STATE_KEY = Symbol.for("bobbit.tests2.integrationHarnessState");

type HarnessGlobal = typeof globalThis & { [key: symbol]: IntegrationHarnessState | undefined };

function emptyCleanupStats(): CleanupStats {
	return {
		snapshots: 0,
		sweeps: 0,
		skippedSweeps: 0,
		defaultResets: 0,
		defaultRestores: 0,
		deletedSessions: 0,
		deletedGoals: 0,
		deletedProjects: 0,
	};
}

function harnessState(): IntegrationHarnessState {
	const global = globalThis as HarnessGlobal;
	let state = global[HARNESS_STATE_KEY];
	if (!state) {
		state = { generation: 0, stats: emptyCleanupStats() };
		global[HARNESS_STATE_KEY] = state;
	}
	return state;
}

function incStat(key: keyof CleanupStats, by = 1): void {
	harnessState().stats[key] += by;
}

function bumpGeneration(): void {
	harnessState().generation++;
}

export function integrationHarnessCleanupStats(): CleanupStats {
	return { ...harnessState().stats };
}

export function resetIntegrationHarnessCleanupStats(): void {
	harnessState().stats = emptyCleanupStats();
}

function profileCleanupStatsPath(): string | undefined {
	const dir = process.env.BOBBIT_V2_HOOK_PROFILE_DIR;
	if (!dir) return undefined;
	const worker = process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID || "worker";
	return join(dir, `integration-harness-cleanup-${process.pid}-${worker}.json`);
}

export function exportIntegrationHarnessCleanupStatsForProfile(): string | undefined {
	const outPath = profileCleanupStatsPath();
	if (!outPath) return undefined;
	const payload = {
		kind: "integration-harness-cleanup-stats",
		createdAt: new Date().toISOString(),
		pid: process.pid,
		vitestWorkerId: process.env.VITEST_WORKER_ID ?? null,
		vitestPoolId: process.env.VITEST_POOL_ID ?? null,
		cleanupStats: integrationHarnessCleanupStats(),
	};
	mkdirSync(process.env.BOBBIT_V2_HOOK_PROFILE_DIR!, { recursive: true });
	const tmpPath = `${outPath}.tmp-${process.pid}`;
	writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
	renameSync(tmpPath, outPath);
	return outPath;
}

function exportIntegrationHarnessCleanupStatsBestEffort(): void {
	try { exportIntegrationHarnessCleanupStatsForProfile(); }
	catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[integration-harness] failed to export cleanup stats: ${message}`);
	}
}

function stableStringify(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

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

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

function findVisibleDefaultContext(gw: GatewayFixture): any | undefined {
	for (const ctx of Array.from(gw.projectContextManager.visible?.() ?? []) as any[]) {
		const proj = ctx?.project;
		if (proj && !proj.hidden && proj.name === "default") return ctx;
	}
	return undefined;
}

function hasVisibleDefaultProject(gw: GatewayFixture): boolean {
	try { return !!findVisibleDefaultContext(gw); }
	catch { return false; }
}

function projectConfigFileFingerprint(rootPath: unknown): string {
	if (typeof rootPath !== "string" || rootPath.length === 0) return "no-root";
	try {
		const stat = statSync(join(rootPath, ".bobbit", "config", "project.yaml"));
		return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
	} catch (err) {
		const code = (err as { code?: unknown })?.code;
		if (code === "ENOENT") return "missing";
		const message = err instanceof Error ? err.message : String(err);
		return `unknown:${message}`;
	}
}

function defaultProjectFingerprint(gw: GatewayFixture): string {
	try {
		const ctx = findVisibleDefaultContext(gw);
		if (!ctx) return "missing";
		const project = ctx.project ?? {};
		const cfg = ctx.projectConfigStore;
		// Keep this path mostly in-memory. The harness calls it from every
		// beforeAll/beforeEach/afterEach; forcing project.yaml reload+YAML parse here
		// adds enough synchronous filesystem work under full-suite concurrency to
		// starve freshly booting gateway forks and trip hook timeouts. A cheap file
		// stat still detects out-of-band project.yaml rewrites so cleanup can take the
		// conservative healing path, while API-driven mutations are caught by the
		// in-memory store fields below.
		return `ok:${stableStringify({
			project: {
				id: project.id,
				name: project.name,
				hidden: !!project.hidden,
				rootPath: project.rootPath,
			},
			configFile: projectConfigFileFingerprint(project.rootPath),
			config: cfg?.getAll?.() ?? null,
			components: cfg?.getComponents?.() ?? null,
			workflows: cfg?.getWorkflows?.() ?? null,
		})}`;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return `unknown:${message}`;
	}
}

function snapshotCleanupState(gw: GatewayFixture): CleanupSnapshot {
	incStat("snapshots");
	const ids = snapshotIds(gw);
	let counts: EntityCounts;
	try { counts = gw.countEntities(); }
	catch { counts = { sessions: ids.sessions.size, goals: ids.goals.size, projects: ids.projects.size }; }
	return {
		ids,
		counts,
		defaultProjectFingerprint: defaultProjectFingerprint(gw),
		generation: harnessState().generation,
	};
}

function fingerprintUncertain(value: string): boolean {
	return value.startsWith("unknown:");
}

function isClean(now: CleanupSnapshot, baseline: CleanupSnapshot): boolean {
	return now.generation === baseline.generation
		&& now.counts.sessions === baseline.counts.sessions
		&& now.counts.goals === baseline.counts.goals
		&& now.counts.projects === baseline.counts.projects
		&& !fingerprintUncertain(now.defaultProjectFingerprint)
		&& !fingerprintUncertain(baseline.defaultProjectFingerprint)
		&& now.defaultProjectFingerprint === baseline.defaultProjectFingerprint
		&& sameSet(now.ids.sessions, baseline.ids.sessions)
		&& sameSet(now.ids.goals, baseline.ids.goals)
		&& sameSet(now.ids.projects, baseline.ids.projects);
}

function cleanupNeeded(gw: GatewayFixture, before: CleanupSnapshot, now = snapshotCleanupState(gw)): boolean {
	return !isClean(now, before);
}

function defaultProjectNeedsHealing(now: CleanupSnapshot, baseline: CleanupSnapshot): boolean {
	return fingerprintUncertain(now.defaultProjectFingerprint)
		|| fingerprintUncertain(baseline.defaultProjectFingerprint)
		|| now.defaultProjectFingerprint !== baseline.defaultProjectFingerprint;
}

async function cleanupTo(gw: GatewayFixture, baseline: CleanupSnapshot, opts: { final?: boolean } = {}): Promise<void> {
	const now = snapshotCleanupState(gw);
	const needed = cleanupNeeded(gw, baseline, now);
	if (!opts.final && !needed) {
		incStat("skippedSweeps");
		return;
	}
	incStat("sweeps");
	for (const id of now.ids.sessions) if (!baseline.ids.sessions.has(id)) {
		const resp = await gw.api(`/api/sessions/${id}?purge=true`, { method: "DELETE" }).catch(() => undefined);
		if (!resp || resp.ok || resp.status === 404) incStat("deletedSessions");
		bumpGeneration();
	}
	for (const id of now.ids.goals) if (!baseline.ids.goals.has(id)) {
		const resp = await gw.api(`/api/goals/${id}?cascade=true`, { method: "DELETE" }).catch(() => undefined);
		if (!resp || resp.ok || resp.status === 404) incStat("deletedGoals");
		bumpGeneration();
	}
	for (const id of now.ids.projects) if (!baseline.ids.projects.has(id) && id !== gw.defaultProjectId) {
		const resp = await gw.api(`/api/projects/${id}`, { method: "DELETE" }).catch(() => undefined);
		if (!resp || resp.ok || resp.status === 404) incStat("deletedProjects");
		bumpGeneration();
	}
	// Heal the default project only when the cleanup snapshot proves it changed:
	//   - MISSING (a test deleted it) → re-register + reseed via restoreDefaultProject().
	//   - PRESENT but its seeded workflows/component config were mutated in place by a
	//     fork-mate (e.g. inline-workflow-goal-flow.test.ts REPLACES the default
	//     project.yaml workflows) → resetDefaultProjectBaseline() restores the seeded
	//     baseline. Proven no-op tests skip this expensive branch entirely.
	// Neither path touches ctx.workflowStore, so workflows a test registered via
	// POST /api/workflows (a separate store) are preserved.
	if (!hasVisibleDefaultProject(gw)) {
		await gw.restoreDefaultProject();
		incStat("defaultRestores");
		bumpGeneration();
	} else if (defaultProjectNeedsHealing(now, baseline)) {
		await gw.resetDefaultProjectBaseline();
		incStat("defaultResets");
		bumpGeneration();
	}
}

function wrapDescribe(name: string, body: DescribeBody): void {
	vDescribe(name, () => {
		let before: EntityCounts;
		let fileBaseline: CleanupSnapshot;
		let testBaseline: CleanupSnapshot;
		// Registered BEFORE the spec's own hooks → beforeAll/beforeEach run first,
		// afterEach/afterAll run last (vitest reverses teardown order), so the
		// sweep + leak assert happen AFTER the spec's own cleanup hooks.
		vBeforeAll(async () => { const gw = await ensureGw(); before = snapshotEntities(gw); fileBaseline = snapshotCleanupState(gw); });
		vBeforeEach(async () => { const gw = await ensureGw(); testBaseline = snapshotCleanupState(gw); setScope(createScope(gw)); });
		vAfterEach(async () => { setScope(undefined); await cleanupTo(await ensureGw(), testBaseline); });
		vAfterAll(async () => {
			try {
				const gw = await ensureGw();
				await cleanupTo(gw, fileBaseline, { final: true });
				assertNoLeaks(before, snapshotEntities(gw));
			} finally {
				exportIntegrationHarnessCleanupStatsBestEffort();
			}
		});
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

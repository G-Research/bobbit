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

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	afterAll as vAfterAll,
	afterEach as vAfterEach,
	beforeAll as vBeforeAll,
	beforeEach as vBeforeEach,
	describe as vDescribe,
	it as vIt,
	expect as vExpect,
} from "vitest";
import { exportGatewayApiProfileForTests, exportProductionProfileForTests, type EntityCounts, type GatewayFixture } from "../../harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../../harness/leak-detector.js";
import { createScope, type TestScope } from "../../harness/scope.js";
import { currentScope, ensureGateway, gatewaySync, setScope } from "./runtime.js";

// Playwright's retrying `await expect(fn).toPass({ timeout })` matcher — vitest
// has no built-in equivalent. The received is a function containing assertions
// that throw until they pass.
vExpect.extend({
	async toPass(received: unknown, opts?: { timeout?: number; intervals?: number[] }) {
		const timeout = opts?.timeout ?? 5_000;
		let clock: GatewayFixture["clock"] | undefined;
		try { clock = gatewaySync().clock; } catch { /* matcher can run before gateway boot */ }
		const start = clock?.now() ?? Date.now();
		let attempt = 0;
		let lastErr: unknown;
		const fn = received as () => unknown | Promise<unknown>;
		for (;;) {
			try { await fn(); return { pass: true, message: () => "expected callback not to pass" }; }
			catch (err) {
				lastErr = err;
				const now = clock?.now() ?? Date.now();
				if (now - start >= timeout) {
					return { pass: false, message: () => `expected callback to pass within ${timeout}ms; last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` };
				}
				const intervals = opts?.intervals;
				const delay = Math.max(1, intervals?.[Math.min(attempt++, intervals.length - 1)] ?? 100);
				if (clock) {
					clock.advance(Math.min(delay, timeout - (now - start)));
					// Yield one real event-loop turn for HTTP/file-system completions without
					// paying the retry interval in wall time. Gateway timers use the manual clock.
					await new Promise<void>(resolve => setImmediate(resolve));
				} else {
					await new Promise(resolve => setTimeout(resolve, delay));
				}
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
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const injected = injectHeadquartersDiscoveryUrl(input, init);
		const response = await originalFetch(injected, init);
		observeGatewayMutation(injected, init, response);
		return response;
	}) as typeof fetch;
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
	defaultGeneration: number;
}

export interface CleanupStats {
	snapshots: number;
	snapshotCalls: number;
	snapshotMs: number;
	fastPathChecks: number;
	dirtySignals: number;
	apiMutationSignals: number;
	defaultDirtySignals: number;
	defaultFingerprintCalls: number;
	sweeps: number;
	skippedSweeps: number;
	uncertainSweeps: number;
	cleanupCalls: number;
	cleanupMs: number;
	defaultResets: number;
	defaultRestores: number;
	deletedSessions: number;
	deletedGoals: number;
	deletedProjects: number;
}

interface IntegrationHarnessState {
	generation: number;
	defaultGeneration: number;
	lastDirtyAt: number;
	suppressSignals: number;
	stats: CleanupStats;
	profileExports: number;
	observedStores: WeakSet<object>;
	expectedStoreReaders: WeakMap<object, Map<string, unknown>>;
}

const HARNESS_STATE_KEY = Symbol.for("bobbit.tests2.integrationHarnessState");

type HarnessGlobal = typeof globalThis & { [key: symbol]: IntegrationHarnessState | undefined };

function emptyCleanupStats(): CleanupStats {
	return {
		snapshots: 0,
		snapshotCalls: 0,
		snapshotMs: 0,
		fastPathChecks: 0,
		dirtySignals: 0,
		apiMutationSignals: 0,
		defaultDirtySignals: 0,
		defaultFingerprintCalls: 0,
		sweeps: 0,
		skippedSweeps: 0,
		uncertainSweeps: 0,
		cleanupCalls: 0,
		cleanupMs: 0,
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
		state = {
			generation: 0,
			defaultGeneration: 0,
			lastDirtyAt: 0,
			suppressSignals: 0,
			stats: emptyCleanupStats(),
			profileExports: 0,
			observedStores: new WeakSet(),
			expectedStoreReaders: new WeakMap(),
		};
		global[HARNESS_STATE_KEY] = state;
	}
	return state;
}

function incStat(key: keyof CleanupStats, by = 1): void {
	harnessState().stats[key] += by;
}

function markDirty(defaultProject = false): void {
	const state = harnessState();
	if (state.suppressSignals > 0) return;
	state.generation++;
	try { state.lastDirtyAt = gatewaySync().clock.now(); }
	catch { state.lastDirtyAt++; }
	incStat("dirtySignals");
	if (defaultProject) {
		state.defaultGeneration++;
		incStat("defaultDirtySignals");
	}
}

function requestBodyProjectId(body: BodyInit | null | undefined): string | undefined {
	if (typeof body !== "string") return undefined;
	try {
		const parsed = JSON.parse(body) as { projectId?: unknown };
		return typeof parsed?.projectId === "string" ? parsed.projectId : undefined;
	} catch { return undefined; }
}

function observeGatewayMutation(input: RequestInfo | URL, init: RequestInit | undefined, response: Response): void {
	const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
	let gw: GatewayFixture;
	try { gw = gatewaySync(); } catch { return; }
	let url: URL;
	try {
		const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		url = new URL(value);
		if (url.origin !== new URL(gw.baseURL).origin) return;
	} catch { return; }

	// Even an error response can follow a partial write. A mutation response is a
	// cheap dirty signal; the cleanup pass decides from live in-memory state
	// whether any sweep is actually needed.
	const defaultId = gw.defaultProjectId;
	let defaultProject = url.pathname === `/api/projects/${defaultId}`
		|| url.pathname.startsWith(`/api/projects/${defaultId}/`);
	if (url.pathname.startsWith("/api/workflows")) {
		defaultProject ||= url.searchParams.get("projectId") === defaultId
			|| requestBodyProjectId(init?.body) === defaultId;
	}
	markDirty(defaultProject);
	incStat("apiMutationSignals");
	void response;
}

const DEFAULT_STORE_MUTATORS = [
	"set", "remove", "setComponents", "setWorkflows", "setConfigDirectories",
	"setSandboxTokens", "setPackOrder", "setPackActivation", "reload",
] as const;
const DEFAULT_STORE_READERS = ["getAll", "getComponents", "getWorkflows", "reload"] as const;

function installDefaultStoreObserver(gw: GatewayFixture): void {
	const ctx = findVisibleDefaultContext(gw);
	const store = ctx?.projectConfigStore as Record<string, unknown> | undefined;
	if (!store || typeof store !== "object") return;
	const state = harnessState();
	if (state.observedStores.has(store)) return;
	for (const name of DEFAULT_STORE_MUTATORS) {
		const original = store[name];
		if (typeof original !== "function") continue;
		store[name] = function observedDefaultStoreMutation(this: unknown, ...args: unknown[]) {
			markDirty(true);
			return (original as (...values: unknown[]) => unknown).apply(this, args);
		};
	}
	state.observedStores.add(store);
	state.expectedStoreReaders.set(store, new Map(DEFAULT_STORE_READERS.map(name => [name, store[name]])));
}

function defaultStoreObserverIntact(gw: GatewayFixture): boolean {
	const ctx = findVisibleDefaultContext(gw);
	const store = ctx?.projectConfigStore as Record<string, unknown> | undefined;
	if (!store || typeof store !== "object") return false;
	installDefaultStoreObserver(gw);
	const expected = harnessState().expectedStoreReaders.get(store);
	if (!expected) return false;
	for (const [name, fn] of expected) if (store[name] !== fn) return false;
	return true;
}

async function suppressDirtySignals<T>(fn: () => Promise<T>): Promise<T> {
	const state = harnessState();
	state.suppressSignals++;
	try { return await fn(); }
	finally { state.suppressSignals--; }
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
	const sequence = String(++harnessState().profileExports).padStart(4, "0");
	return join(dir, `integration-harness-cleanup-${process.pid}-${worker}-${sequence}.json`);
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
		profileSequence: harnessState().profileExports,
		cleanupStats: integrationHarnessCleanupStats(),
	};
	mkdirSync(process.env.BOBBIT_V2_HOOK_PROFILE_DIR!, { recursive: true });
	const tmpPath = `${outPath}.tmp-${process.pid}`;
	writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
	renameSync(tmpPath, outPath);
	try {
		exportProductionProfileForTests();
		exportGatewayApiProfileForTests();
	} catch { /* profiling must never affect cleanup */ }
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

function defaultProjectFingerprint(gw: GatewayFixture): string {
	incStat("defaultFingerprintCalls");
	try {
		const ctx = findVisibleDefaultContext(gw);
		if (!ctx) return "missing";
		const project = ctx.project ?? {};
		const cfg = ctx.projectConfigStore;
		// No file stat or YAML reload here. The default store observer and successful
		// API mutation observer provide the dirty signal; reload() is itself observed,
		// so an out-of-band project.yaml write is noticed when the server consumes it.
		return `ok:${stableStringify({
			project: {
				id: project.id,
				name: project.name,
				hidden: !!project.hidden,
				rootPath: project.rootPath,
			},
			config: cfg?.getAll?.() ?? null,
			components: cfg?.getComponents?.() ?? null,
			workflows: cfg?.getWorkflows?.() ?? null,
		})}`;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return `unknown:${message}`;
	}
}

function snapshotCleanupState(
	gw: GatewayFixture,
	opts: { defaultProjectFingerprint?: string } = {},
): CleanupSnapshot {
	const startedAt = performance.now();
	incStat("snapshots");
	incStat("snapshotCalls");
	try {
		const ids = snapshotIds(gw);
		let counts: EntityCounts;
		try { counts = gw.countEntities(); }
		catch { counts = { sessions: ids.sessions.size, goals: ids.goals.size, projects: ids.projects.size }; }
		const state = harnessState();
		return {
			ids,
			counts,
			defaultProjectFingerprint: opts.defaultProjectFingerprint ?? defaultProjectFingerprint(gw),
			generation: state.generation,
			defaultGeneration: state.defaultGeneration,
		};
	} finally {
		incStat("snapshotMs", performance.now() - startedAt);
	}
}

function fingerprintUncertain(value: string): boolean {
	return value.startsWith("unknown:");
}

function sameCounts(a: EntityCounts, b: EntityCounts): boolean {
	return a.sessions === b.sessions && a.goals === b.goals && a.projects === b.projects;
}

function isClean(now: CleanupSnapshot, baseline: CleanupSnapshot): boolean {
	return sameCounts(now.counts, baseline.counts)
		&& !fingerprintUncertain(now.defaultProjectFingerprint)
		&& !fingerprintUncertain(baseline.defaultProjectFingerprint)
		&& now.defaultProjectFingerprint === baseline.defaultProjectFingerprint
		&& sameSet(now.ids.sessions, baseline.ids.sessions)
		&& sameSet(now.ids.goals, baseline.ids.goals)
		&& sameSet(now.ids.projects, baseline.ids.projects);
}

function defaultProjectNeedsHealing(now: CleanupSnapshot, baseline: CleanupSnapshot): boolean {
	return fingerprintUncertain(now.defaultProjectFingerprint)
		|| fingerprintUncertain(baseline.defaultProjectFingerprint)
		|| now.defaultProjectFingerprint !== baseline.defaultProjectFingerprint;
}

async function cleanupTo(gw: GatewayFixture, baseline: CleanupSnapshot): Promise<CleanupSnapshot> {
	const startedAt = performance.now();
	incStat("cleanupCalls");
	try {
		installDefaultStoreObserver(gw);
		incStat("fastPathChecks");
		const state = harnessState();
		let counts: EntityCounts | undefined;
		try { counts = gw.countEntities(); } catch { /* force the conservative path */ }
		const observerIntact = defaultStoreObserverIntact(gw);
		const defaultDirty = state.defaultGeneration !== baseline.defaultGeneration
			|| !observerIntact
			|| !hasVisibleDefaultProject(gw);
		const entityDirty = state.generation !== baseline.generation
			|| !counts
			|| !sameCounts(counts, baseline.counts);
		if (!entityDirty && !defaultDirty) {
			incStat("skippedSweeps");
			return baseline;
		}

		const fingerprint = !observerIntact
			? "unknown:default project store observer changed"
			: defaultDirty
				? defaultProjectFingerprint(gw)
				: baseline.defaultProjectFingerprint;
		const now = snapshotCleanupState(gw, { defaultProjectFingerprint: fingerprint });
		if (isClean(now, baseline)) {
			incStat("skippedSweeps");
			return now;
		}

		incStat("sweeps");
		if (fingerprintUncertain(now.defaultProjectFingerprint) || fingerprintUncertain(baseline.defaultProjectFingerprint)) incStat("uncertainSweeps");
		await suppressDirtySignals(async () => {
			for (const id of now.ids.sessions) if (!baseline.ids.sessions.has(id)) {
				const resp = await gw.api(`/api/sessions/${id}?purge=true`, { method: "DELETE" }).catch(() => undefined);
				if (!resp || resp.ok || resp.status === 404) incStat("deletedSessions");
			}
			for (const id of now.ids.goals) if (!baseline.ids.goals.has(id)) {
				const resp = await gw.api(`/api/goals/${id}?cascade=true`, { method: "DELETE" }).catch(() => undefined);
				if (!resp || resp.ok || resp.status === 404) incStat("deletedGoals");
			}
			for (const id of now.ids.projects) if (!baseline.ids.projects.has(id) && id !== gw.defaultProjectId) {
				const resp = await gw.api(`/api/projects/${id}`, { method: "DELETE" }).catch(() => undefined);
				if (!resp || resp.ok || resp.status === 404) incStat("deletedProjects");
			}
			// Heal only proven changes. No-op tests never call either expensive helper.
			if (!hasVisibleDefaultProject(gw)) {
				await gw.restoreDefaultProject();
				incStat("defaultRestores");
			} else if (defaultProjectNeedsHealing(now, baseline)) {
				await gw.resetDefaultProjectBaseline();
				incStat("defaultResets");
			}
		});

		installDefaultStoreObserver(gw);
		const cleanFingerprint = defaultStoreObserverIntact(gw)
			? defaultProjectFingerprint(gw)
			: baseline.defaultProjectFingerprint;
		return snapshotCleanupState(gw, { defaultProjectFingerprint: cleanFingerprint });
	} finally {
		incStat("cleanupMs", performance.now() - startedAt);
	}
}

function wrapDescribe(name: string, body: DescribeBody): void {
	vDescribe(name, () => {
		let before: EntityCounts;
		let cleanBaseline: CleanupSnapshot;
		let testBaseline: CleanupSnapshot;
		// Registered BEFORE the spec's own hooks → beforeAll/beforeEach run first,
		// afterEach/afterAll run last (vitest reverses teardown order), so the
		// sweep + leak assert happen AFTER the spec's own cleanup hooks.
		vBeforeAll(async () => {
			const gw = await ensureGw();
			installDefaultStoreObserver(gw);
			before = snapshotEntities(gw);
			cleanBaseline = snapshotCleanupState(gw);
		});
		vBeforeEach(async () => {
			const gw = await ensureGw();
			installDefaultStoreObserver(gw);
			testBaseline = cleanBaseline;
			setScope(createScope(gw));
		});
		vAfterEach(async () => {
			setScope(undefined);
			cleanBaseline = await cleanupTo(await ensureGw(), testBaseline);
		});
		vAfterAll(async () => {
			try {
				const gw = await ensureGw();
				cleanBaseline = await cleanupTo(gw, cleanBaseline);
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

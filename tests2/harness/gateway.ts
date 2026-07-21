/**
 * Tier-1 gateway fixture for Test Suite v2 (vitest).
 *
 * Boots ONE real gateway per vitest fork from the content-addressed `src/server`
 * runtime bundle (never `dist/`), mirroring the durable parts of tests/e2e/in-process-harness.ts
 * while eliminating every `BOBBIT_TEST_*` / `BOBBIT_SKIP_*` env flag. All
 * configuration flows through explicit `GatewayConfig` options + `GatewayDeps`:
 *
 *   - manual Clock (deterministic timers; production always uses realClock)
 *   - fenced CommandRunner (fail-closed: no gh/docker, no non-local git remotes)
 *   - fenced fetch (fail-closed: loopback-only outbound HTTP)
 *   - in-process mock agent bridge (no Node subprocess per agent)
 *
 * Vitest fork workers reuse the same process across test files (pool:"forks",
 * isolate:false), so a module-level singleton = "boot once per fork". The fork
 * process dies at end of run; a best-effort sync temp-dir sweep runs on exit.
 *
 * Per-test isolation is the caller's responsibility via `createScope()`
 * (see scope.ts) + `assertNoLeaks()` (see leak-detector.ts).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";

import type { GatewayDeps } from "../../src/server/gateway-deps.js";
import { testWorkflows, TEST_DEFAULT_COMPONENT } from "../../tests/e2e/seed-workflows.js";
import { createManualClock, type ManualClock } from "./clock.js";
import { createFencedCommandRunner } from "./fenced-command-runner.js";
import { createFencedFetch } from "./fenced-fetch.js";
import { createFakeVerificationCommandRunner } from "./fake-verification-command-runner.js";
import { loadServerTestRuntime, serverRuntimeMode } from "./server-runtime.js";

const HARNESS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HARNESS_DIR, "..", "..");
const MOCK_AGENT = resolve(REPO_ROOT, "tests", "e2e", "mock-agent.mjs");
const apiProfileRecords: Array<{ method: string; path: string; status: number; durationMs: number; endedAt: number }> = [];
let apiProfileExitRegistered = false;
let apiProfileExportSequence = 0;
let productionProfileSnapshot: (() => unknown) | undefined;
export function exportProductionProfileForTests(dir = process.env.BOBBIT_V2_HOOK_PROFILE_DIR): string | undefined {
	if (!dir || !productionProfileSnapshot) return undefined;
	mkdirSync(dir, { recursive: true });
	const sequence = String(apiProfileExportSequence + 1).padStart(4, "0");
	const outPath = join(dir, `production-profile-${process.pid}-${sequence}.json`);
	writeFileSync(outPath, `${JSON.stringify(productionProfileSnapshot(), null, 2)}\n`);
	return outPath;
}
export function exportGatewayApiProfileForTests(dir = process.env.BOBBIT_V2_HOOK_PROFILE_DIR): string | undefined {
	if (!dir) return undefined;
	mkdirSync(dir, { recursive: true });
	const sequence = String(++apiProfileExportSequence).padStart(4, "0");
	const outPath = join(dir, `gateway-api-${process.pid}-${sequence}.json`);
	writeFileSync(outPath, `${JSON.stringify({ sequence: apiProfileExportSequence, records: apiProfileRecords }, null, 2)}\n`);
	return outPath;
}
export function recordProfiledApiCall(method: string, path: string, status: number, durationMs: number): void {
	const dir = process.env.BOBBIT_V2_HOOK_PROFILE_DIR;
	if (!dir) return;
	apiProfileRecords.push({ method, path: path.split("?", 1)[0], status, durationMs, endedAt: Date.now() });
	if (apiProfileExitRegistered) return;
	apiProfileExitRegistered = true;
	process.once("exit", () => {
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `gateway-api-${process.pid}.json`), `${JSON.stringify(apiProfileRecords, null, 2)}\n`);
		} catch { /* profiling must never affect test behavior */ }
	});
}
// Src-booted gateway: __dirname resolves builtins to non-existent src paths, so
// point the builtin config + packs at the repo-root source trees (dist-relative
// defaults only exist after a build). Production/legacy dist-boot leave these
// undefined and keep their dist-relative defaults.
const BUILTINS_DIR = resolve(REPO_ROOT, "defaults");
// Source-of-truth for the shipped first-party pack SET is
// scripts/copy-builtin-packs.mjs (FIRST_PARTY_PACKS). The repo-root
// `market-packs/` SOURCE tree additionally carries test-only packs that dist
// never ships (e.g. the `artifacts` litmus pack, whose provider-less
// `artifact_demo` tool would otherwise surface with origin "mcp" in
// /api/tools and diverge from the legacy/production dist cascade). We therefore
// stage a CURATED builtin-packs dir per fork that mirrors the dist allowlist
// exactly, so the v2 tools/roles cascade matches legacy. Keep this list in
// sync with scripts/copy-builtin-packs.mjs::FIRST_PARTY_PACKS.
const BUILTIN_PACKS_SRC = resolve(REPO_ROOT, "market-packs");
const FIRST_PARTY_PACKS = ["pr-walkthrough", "terminal"] as const;
const BUILTIN_PACK_SKIP_DIRS = new Set(["src", "node_modules"]);
const MOCK_BRIDGE_SPECIFIER = new URL("../../tests/e2e/in-process-mock-bridge.mjs", import.meta.url).href;

// Keep write-heavy temp dirs off the repo tree so isGitRepo() never fires and
// sessions do not auto-create worktrees. Windows Defender-heavy project paths
// are avoided by anchoring under the OS temp root.
const TMP_ROOT = process.platform === "win32"
	? (process.env.BOBBIT_V2_TMP_ROOT || "C:\\bobbit-v2")
	: join(tmpdir(), "bobbit-v2");

export interface EntityCounts {
	sessions: number;
	goals: number;
	projects: number;
}

export interface GatewayFixture {
	readonly baseURL: string;
	readonly wsBase: string;
	readonly token: string;
	readonly bobbitDir: string;
	readonly defaultProjectId: string;
	readonly clock: ManualClock;
	/** @internal subsystem handles for tests that drive the gateway directly */
	readonly sessionManager: any;
	readonly teamManager: any;
	readonly orchestrationCore: any;
	readonly bgProcessManager: any;
	readonly projectContextManager: any;
	/** Authed fetch against the gateway; `path` starts with `/`. */
	api(path: string, init?: RequestInit): Promise<Response>;
	/** Authed fetch returning parsed JSON, throwing on non-2xx. */
	apiJson<T = any>(path: string, init?: RequestInit): Promise<T>;
	/** Open an authed WebSocket (`/ws/<suffix>`); resolves after auth_ok. */
	connectWs(suffix: string, opts?: { goalId?: string; clientKind?: string }): Promise<WebSocket>;
	/** Snapshot live entity counts (used by the leak detector). */
	countEntities(): EntityCounts;
	/** Re-create/reseed the default project after a test deletes or mutates it. */
	restoreDefaultProject(): Promise<void>;
	/** Restore process-global runtime singletons after fork-mate tests reset them. */
	restoreAgentDirRuntime(): void;
	/**
	 * Reset the default project's seeded workflows + component config back to the
	 * baseline when a fork-mate mutated them in place (the default project still
	 * exists, so `restoreDefaultProject` — which only heals a MISSING default —
	 * would not fix it). No-op when the baseline is already intact.
	 */
	resetDefaultProjectBaseline(): Promise<void>;
}

interface BootedGateway extends GatewayFixture {
	shutdown(): Promise<void>;
}

let bootPromise: Promise<BootedGateway> | undefined;
let exitHookRegistered = false;

function projectYaml(): string {
	// Minimal inline project.yaml: default component + inline test workflows,
	// matching the shape in-process-harness seeds pre-boot.
	const workflows = testWorkflows();
	const componentLines = Object.entries(TEST_DEFAULT_COMPONENT.commands ?? {})
		.map(([name, cmd]) => `      ${name}: ${JSON.stringify(cmd)}`)
		.join("\n");
	const wfJson = JSON.stringify(workflows, null, 2)
		.split("\n")
		.map(line => `  ${line}`)
		.join("\n");
	return [
		"name: default",
		"components:",
		`  - name: ${TEST_DEFAULT_COMPONENT.name}`,
		`    repo: ${JSON.stringify(TEST_DEFAULT_COMPONENT.repo)}`,
		"    commands:",
		componentLines,
		"workflows:",
		wfJson,
		"",
	].join("\n");
}

async function seedDefaultWorkflows(baseURL: string, token: string, projectId: string): Promise<void> {
	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
	let current: Record<string, any> = {};
	try {
		const cfgResp = await fetch(`${baseURL}/api/projects/${projectId}/config`, { headers });
		if (cfgResp.ok) current = await cfgResp.json();
	} catch { /* additive seed on failure */ }
	const existingWorkflows = current.workflows && typeof current.workflows === "object" && !Array.isArray(current.workflows)
		? current.workflows as Record<string, unknown>
		: {};
	const workflows = { ...testWorkflows(), ...existingWorkflows };
	const existingComponents = Array.isArray(current.components) ? current.components : [];
	const names = new Set(existingComponents.map((c: any) => c?.name).filter((n: unknown): n is string => typeof n === "string"));
	const components = names.has(TEST_DEFAULT_COMPONENT.name) ? existingComponents : [...existingComponents, TEST_DEFAULT_COMPONENT];
	const resp = await fetch(`${baseURL}/api/projects/${projectId}/config`, {
		method: "PUT",
		headers,
		body: JSON.stringify({ components, workflows }),
	});
	if (!resp.ok) {
		const body = await resp.text().catch(() => "<failed to read body>");
		throw new Error(`[tests2/gateway] default workflow seed failed: ${resp.status} ${resp.statusText} body=${body}`);
	}
}

async function registerDefaultProject(baseURL: string, token: string, rootPath: string): Promise<string> {
	const resp = await fetch(`${baseURL}/api/projects`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ name: "default", rootPath, upsert: true, acceptCanonical: true }),
	});
	const text = await resp.text().catch(() => "<failed to read body>");
	if (!resp.ok) throw new Error(`[tests2/gateway] default project register failed: ${resp.status} ${resp.statusText} body=${text}`);
	const project = JSON.parse(text) as { id?: string };
	if (!project.id) throw new Error(`[tests2/gateway] default project register returned no id: ${text}`);
	return project.id;
}

/**
 * Stage a curated builtin-packs dir under `<bobbitDir>/builtin-packs/market-packs`
 * containing ONLY the dist-shipped first-party packs (FIRST_PARTY_PACKS), copied
 * from the repo-root source tree the same way scripts/copy-builtin-packs.mjs does
 * (skipping `src/` and `node_modules/`). The literal `market-packs` path segment
 * is preserved so pack-identity derivation (derivePackId/packIdFromRoot/
 * isMarketPackBaseDir) resolves stable packIds unchanged. Returns the path to the
 * curated `market-packs` dir to pass as `builtinPacksDir`.
 */
function prepareBuiltinPacksDir(bobbitDir: string): string {
	const curated = join(bobbitDir, "builtin-packs", "market-packs");
	mkdirSync(curated, { recursive: true });
	for (const name of FIRST_PARTY_PACKS) {
		const src = join(BUILTIN_PACKS_SRC, name);
		if (!existsSync(src)) throw new Error(`[tests2/gateway] first-party pack not found: ${src}`);
		cpSync(src, join(curated, name), {
			recursive: true,
			filter: (source) => !BUILTIN_PACK_SKIP_DIRS.has(source.split(/[\\/]/).pop() ?? ""),
		});
	}
	return curated;
}

async function boot(): Promise<BootedGateway> {
	mkdirSync(TMP_ROOT, { recursive: true });
	let bobbitDir = mkdtempSync(join(TMP_ROOT, `fork-${process.pid}-`));
	try { bobbitDir = realpathSync(bobbitDir); } catch { /* platform edge */ }

	const stateDir = join(bobbitDir, "state");
	const agentDir = join(bobbitDir, "agent");
	const secretsDir = join(bobbitDir, "secrets");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(secretsDir, { recursive: true });
	mkdirSync(join(stateDir, "session-prompts"), { recursive: true });

	const defaultProjectRoot = join(bobbitDir, "default-project");
	mkdirSync(defaultProjectRoot, { recursive: true });

	// Seed state exactly as in-process-harness: empty projects list, setup
	// marker, subgoals-experimental ON (so nested-goal tests work unchanged).
	writeFileSync(join(stateDir, "projects.json"), "[]");
	writeFileSync(join(stateDir, "setup-complete"), "tests2\n");
	writeFileSync(join(stateDir, "preferences.json"), JSON.stringify({ subgoalsEnabled: true }, null, 2));

	// BOBBIT_DIR / BOBBIT_AGENT_DIR are the real runtime dir vars (also set in
	// production by cli.ts) — NOT test-only flags. Everything else is config.
	process.env.BOBBIT_DIR = bobbitDir;
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.BOBBIT_SECRETS_DIR = secretsDir;

	// Seed inline workflows at both cascade levels BEFORE boot (mirrors harness).
	const yaml = projectYaml();
	const serverConfigDir = join(bobbitDir, "config");
	mkdirSync(serverConfigDir, { recursive: true });
	writeFileSync(join(serverConfigDir, "project.yaml"), yaml);
	const projectConfigDir = join(defaultProjectRoot, ".bobbit", "config");
	mkdirSync(projectConfigDir, { recursive: true });
	writeFileSync(join(projectConfigDir, "project.yaml"), yaml);

	// Vitest prepares one content-addressed server bundle before workers start;
	// each fork loads that already-published runtime through the worker cache.
	const runtime = await loadServerTestRuntime();
	productionProfileSnapshot = runtime.profiling.snapshot;
	const { getAgentDirState, initializeAgentDirRuntime, setProjectRoot } = runtime.bobbitDir;
	const { scaffoldBobbitDir } = runtime.scaffold;
	const { loadOrCreateToken } = runtime.authToken;
	const { createGateway } = runtime.server;
	const { configureAigwRuntimeFlags } = runtime.aigwManager;
	console.log(`[tests2/gateway] fork ${process.pid}: server runtime=${serverRuntimeMode()}`);

	setProjectRoot(bobbitDir);
	scaffoldBobbitDir(bobbitDir);
	const token = loadOrCreateToken();

	const mockBridge: any = await import(MOCK_BRIDGE_SPECIFIER);
	const agentBridgeFactory: GatewayDeps["agentBridgeFactory"] = (opts: any) => {
		if (mockBridge.shouldUseInProcessMock(opts.cliPath)) return new mockBridge.InProcessMockBridge(opts);
		return null;
	};

	const clock = createManualClock();
	// Command-STEP executor seam: default is the real durable spawn path (same as
	// production). A fork whose vitest project opts in (globalThis flag set by the
	// v2-integration-fake setup file) injects the non-spawning fake so verification
	// command steps produce their observable verdict WITHOUT cmd.exe/Git-Bash
	// spawns. Everything else (verification-core, durability/cancel tests) keeps
	// the real path. See docs/testing-v2/gateway-cost-feasibility.md.
	const useFakeCommandStep = (globalThis as { __BOBBIT_V2_FAKE_CMD_STEP__?: boolean }).__BOBBIT_V2_FAKE_CMD_STEP__ === true;
	const deps: GatewayDeps = {
		clock,
		commandRunner: createFencedCommandRunner(runtime.gatewayDeps.realCommandRunner),
		fetchImpl: createFencedFetch(),
		agentBridgeFactory,
		...(useFakeCommandStep ? { commandStepRunner: createFakeVerificationCommandRunner() } : {}),
	};
	if (useFakeCommandStep) console.log(`[tests2/gateway] fork ${process.pid}: injecting FAKE verification command-step runner (no shell spawns)`);

	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: bobbitDir,
		forceAuth: true,
		agentCliPath: MOCK_AGENT,
		// Explicit config replaces the legacy env flags. Remote/network fencing
		// is enforced structurally by the fenced CommandRunner/fetch above; these
		// keep the in-process git helpers on the no-remote fast path too.
		skipMcp: true,
		skipWorktreePool: true,
		skipTitleGeneration: true,
		skipRemotePush: true,
		skipNonLocalRemoteGit: true,
		builtinsDir: BUILTINS_DIR,
		builtinPacksDir: prepareBuiltinPacksDir(bobbitDir),
	}, deps);

	// Suppress the startup internet probe / aigw auto-discovery without env flags.
	// createGateway seeds these from env (all false here); override before start().
	configureAigwRuntimeFlags({ skipAigwDiscovery: true, testNoExternal: true, e2e: true });

	const port = await gw.start();
	const baseURL = `http://127.0.0.1:${port}`;
	const wsBase = `ws://127.0.0.1:${port}`;
	writeFileSync(join(stateDir, "gateway-url"), baseURL, "utf-8");

	const defaultProjectId = await registerDefaultProject(baseURL, token, defaultProjectRoot);
	await seedDefaultWorkflows(baseURL, token, defaultProjectId);

	// Live holder for the default project id. A test can delete/mutate the default
	// project; restoreDefaultProject() re-registers (or re-resolves) it and gets a
	// FRESH server-assigned id. Consumers (scope.ts createSession/createGoal, the
	// "never delete default" guard) must always see the CURRENT id, so the fixture
	// exposes `defaultProjectId` as a getter over this holder rather than a value
	// captured once at boot (which would dangle at a deleted project → 404 flakes).
	let currentDefaultProjectId = defaultProjectId;
	const sameRuntimePath = (a: string | undefined, b: string): boolean => {
		if (!a) return false;
		try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); }
	};
	const restoreAgentDirRuntime = (): void => {
		process.env.BOBBIT_DIR = bobbitDir;
		process.env.BOBBIT_AGENT_DIR = agentDir;
		process.env.BOBBIT_SECRETS_DIR = secretsDir;
		setProjectRoot(bobbitDir);
		try {
			const state = getAgentDirState();
			if (sameRuntimePath(state.startup.dir, agentDir) && sameRuntimePath(state.startup.projectRoot, bobbitDir)) return;
		} catch { /* singleton was reset by a fork-mate test */ }
		initializeAgentDirRuntime({ projectRoot: bobbitDir, stateDir });
	};

	const authHeaders = (extra?: HeadersInit): HeadersInit => ({ Authorization: `Bearer ${token}`, ...(extra ?? {}) });

	const fixture: BootedGateway = {
		baseURL,
		wsBase,
		token,
		bobbitDir,
		get defaultProjectId() { return currentDefaultProjectId; },
		clock,
		sessionManager: gw.sessionManager,
		teamManager: (gw as any).teamManager,
		orchestrationCore: (gw as any).orchestrationCore,
		bgProcessManager: gw.bgProcessManager,
		projectContextManager: gw.projectContextManager,
		restoreAgentDirRuntime,
		async api(path, init) {
			restoreAgentDirRuntime();
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${token}`);
			if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
			const startedAt = performance.now();
			try {
				const response = await fetch(`${baseURL}${path}`, { ...init, headers });
				recordProfiledApiCall(init?.method ?? "GET", path, response.status, performance.now() - startedAt);
				return response;
			} catch (error) {
				recordProfiledApiCall(init?.method ?? "GET", path, 0, performance.now() - startedAt);
				throw error;
			}
		},
		async apiJson<T = any>(path: string, init?: RequestInit): Promise<T> {
			const resp = await this.api(path, init);
			const text = await resp.text();
			if (!resp.ok) throw new Error(`[tests2/gateway] ${init?.method ?? "GET"} ${path} -> ${resp.status} ${resp.statusText}: ${text}`);
			return (text ? JSON.parse(text) : undefined) as T;
		},
		async connectWs(suffix, opts) {
			restoreAgentDirRuntime();
			const { default: WS } = await import("ws");
			const target = `${wsBase}/ws/${suffix}`;
			return await new Promise<WebSocket>((resolvePromise, reject) => {
				const ws = new WS(target);
				const onError = (err: unknown) => { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); };
				const onMessage = (raw: WebSocket.RawData) => {
					let msg: any;
					try { msg = JSON.parse(String(raw)); } catch { return; }
					if (msg.type === "auth_ok") { cleanup(); resolvePromise(ws); }
					else if (msg.type === "auth_failed") { cleanup(); ws.close(); reject(new Error("[tests2/gateway] ws auth_failed")); }
				};
				const cleanup = () => { ws.off("error", onError); ws.off("message", onMessage); };
				ws.on("error", onError);
				ws.on("message", onMessage);
				ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, ...(opts?.clientKind ? { clientKind: opts.clientKind } : {}), ...(opts?.goalId ? { goalId: opts.goalId } : {}) })));
			});
		},
		countEntities() {
			let sessions = 0;
			let goals = 0;
			let projects = 0;
			try { sessions = (gw.sessionManager.listSessions?.() ?? []).length; } catch { /* ignore */ }
			try {
				const contexts = Array.from(gw.projectContextManager.visible?.() ?? []) as any[];
				projects = contexts.length;
				for (const ctx of contexts) {
					const all = ctx.goalStore?.getAll?.() ?? [];
					goals += all.filter((g: any) => !g?.archived).length;
				}
			} catch { /* ignore */ }
			return { sessions, goals, projects };
		},
		async resetDefaultProjectBaseline() {
			const id = currentDefaultProjectId;
			if (!id) return;
			// Reset in-process through the SAME stores the server resolves from
			// (project.yaml-backed). GET /api/projects/:id/config deliberately omits the
			// workflows block, and PUT config REPLACES it — so a read-merge-write over the
			// API would clobber workflows a test registered via POST /api/workflows (also
			// project.yaml-backed, via ctx.workflowStore). Instead we surgically restore
			// ONLY the seeded ids, leaving every extra workflow untouched.
			let cfg: any;
			try { cfg = gw.projectContextManager.getOrCreate(id)?.projectConfigStore; } catch { return; }
			if (!cfg) return;
			try { cfg.reload(); } catch { /* pick up any out-of-band project.yaml writes */ }
			const seeded = testWorkflows();
			const block = (cfg.getWorkflows?.() ?? {}) as Record<string, unknown>;
			const components = (cfg.getComponents?.() ?? []) as Array<{ name?: string; commands?: Record<string, unknown> }>;
			const testComp = components.find(c => c?.name === TEST_DEFAULT_COMPONENT.name);
			const cmds = (testComp?.commands ?? {}) as Record<string, unknown>;
			const expectedCmds = TEST_DEFAULT_COMPONENT.commands ?? {};
			const componentOk = !!testComp && Object.entries(expectedCmds).every(([k, v]) => cmds[k] === v);
			const workflowsOk = Object.keys(seeded).every(k => k in block);
			// Fast path: baseline intact → no write (common case, every uncorrupted test).
			if (componentOk && workflowsOk) return;
			// Restore seeded workflows (baseline wins on seeded keys); preserve any EXTRA
			// workflow a fork-mate/test added (e.g. gate-resign-cancel's `test-slow`).
			if (!workflowsOk) { try { cfg.setWorkflows({ ...block, ...(seeded as Record<string, unknown>) }); } catch { /* best-effort */ } }
			// Restore the seeded component set so a fork-mate's stray/renamed component
			// (e.g. inline-workflow-goal-flow's `default`) can't linger and break the
			// component-linked verification steps of seeded workflows.
			if (!componentOk) { try { cfg.setComponents([TEST_DEFAULT_COMPONENT]); } catch { /* best-effort */ } }
		},
		async restoreDefaultProject() {
			// If the default still exists (test only mutated it), keep its id — do NOT
			// re-register (that would create a duplicate). Otherwise re-register and
			// adopt the new id. Either way, publish the resolved id to the live holder
			// so subsequent createSession/createGoal calls target a real project.
			const list = await this.apiJson<any>("/api/projects");
			const projects: Array<{ id?: string; name?: string; hidden?: boolean }> = Array.isArray(list) ? list : (list?.projects ?? []);
			const existing = projects.find(p => !p.hidden && p.name === "default" && p.id);
			if (existing?.id) {
				currentDefaultProjectId = existing.id;
				await seedDefaultWorkflows(baseURL, token, existing.id);
				return;
			}
			mkdirSync(defaultProjectRoot, { recursive: true });
			const id = await registerDefaultProject(baseURL, token, defaultProjectRoot);
			currentDefaultProjectId = id;
			await seedDefaultWorkflows(baseURL, token, id);
		},
		async shutdown() {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		},
	};

	if (!exitHookRegistered) {
		exitHookRegistered = true;
		process.once("exit", () => { try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* sync best-effort */ } });
	}

	void authHeaders; // reserved for future WS/header helpers
	return fixture;
}

/**
 * Return the fork-scoped gateway, booting it on first call. Subsequent calls in
 * the same fork return the identical instance (isolate:false keeps the module).
 */
export async function getGateway(): Promise<GatewayFixture> {
	if (!bootPromise) bootPromise = boot();
	const gw = await bootPromise;
	gw.restoreAgentDirRuntime();
	return gw;
}

/** Best-effort synchronous cleanup for a stray temp dir left by a crashed run. */
export function sweepStaleTempDirs(): void {
	if (!existsSync(TMP_ROOT)) return;
	// Cleanup is intentionally limited to the current fork's shutdown/exit hooks.
}

/**
 * Tier-1 gateway fixture for Test Suite v2 (vitest).
 *
 * Boots ONE real gateway per vitest fork, imported directly from `src/`
 * (never `dist/`), mirroring the durable parts of tests/e2e/in-process-harness.ts
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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type WebSocket from "ws";

import { setProjectRoot } from "../../src/server/bobbit-dir.js";
import { scaffoldBobbitDir } from "../../src/server/scaffold.js";
import { loadOrCreateToken } from "../../src/server/auth/token.js";
import { createGateway } from "../../src/server/server.js";
import { configureAigwRuntimeFlags } from "../../src/server/agent/aigw-manager.js";
import type { GatewayDeps } from "../../src/server/gateway-deps.js";
import { testWorkflows, TEST_DEFAULT_COMPONENT } from "../../tests/e2e/seed-workflows.js";
import { createManualClock, type ManualClock } from "./clock.js";
import { createFencedCommandRunner } from "./fenced-command-runner.js";
import { createFencedFetch } from "./fenced-fetch.js";

const HARNESS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HARNESS_DIR, "..", "..");
const MOCK_AGENT = resolve(REPO_ROOT, "tests", "e2e", "mock-agent.mjs");
// Src-booted gateway: __dirname resolves builtins to non-existent src paths, so
// point the builtin config + packs at the repo-root source trees (dist-relative
// defaults only exist after a build). Production/legacy dist-boot leave these
// undefined and keep their dist-relative defaults.
const BUILTINS_DIR = resolve(REPO_ROOT, "defaults");
const BUILTIN_PACKS_DIR = resolve(REPO_ROOT, "market-packs");
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

async function boot(): Promise<BootedGateway> {
	mkdirSync(TMP_ROOT, { recursive: true });
	let bobbitDir = mkdtempSync(join(TMP_ROOT, `fork-${process.pid}-`));
	try { bobbitDir = realpathSync(bobbitDir); } catch { /* platform edge */ }

	const stateDir = join(bobbitDir, "state");
	const agentDir = join(bobbitDir, "agent");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
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

	// Seed inline workflows at both cascade levels BEFORE boot (mirrors harness).
	const yaml = projectYaml();
	const serverConfigDir = join(bobbitDir, "config");
	mkdirSync(serverConfigDir, { recursive: true });
	writeFileSync(join(serverConfigDir, "project.yaml"), yaml);
	const projectConfigDir = join(defaultProjectRoot, ".bobbit", "config");
	mkdirSync(projectConfigDir, { recursive: true });
	writeFileSync(join(projectConfigDir, "project.yaml"), yaml);

	setProjectRoot(bobbitDir);
	scaffoldBobbitDir(bobbitDir);
	const token = loadOrCreateToken();

	const mockBridge: any = await import(MOCK_BRIDGE_SPECIFIER);
	const agentBridgeFactory: GatewayDeps["agentBridgeFactory"] = (opts: any) => {
		if (mockBridge.shouldUseInProcessMock(opts.cliPath)) return new mockBridge.InProcessMockBridge(opts);
		return null;
	};

	const clock = createManualClock();
	const deps: GatewayDeps = {
		clock,
		commandRunner: createFencedCommandRunner(),
		fetchImpl: createFencedFetch(),
		agentBridgeFactory,
	};

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
		builtinPacksDir: BUILTIN_PACKS_DIR,
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
		async api(path, init) {
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${token}`);
			if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
			return fetch(`${baseURL}${path}`, { ...init, headers });
		},
		async apiJson<T = any>(path: string, init?: RequestInit): Promise<T> {
			const resp = await this.api(path, init);
			const text = await resp.text();
			if (!resp.ok) throw new Error(`[tests2/gateway] ${init?.method ?? "GET"} ${path} -> ${resp.status} ${resp.statusText}: ${text}`);
			return (text ? JSON.parse(text) : undefined) as T;
		},
		async connectWs(suffix, opts) {
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
export function getGateway(): Promise<GatewayFixture> {
	if (!bootPromise) bootPromise = boot();
	return bootPromise;
}

/** Best-effort synchronous cleanup for a stray temp dir left by a crashed run. */
export function sweepStaleTempDirs(): void {
	if (!existsSync(TMP_ROOT)) return;
	// Intentionally conservative: only remove obviously-orphaned fork dirs whose
	// owning pid is gone. Left as a no-op sweep hook for the ledger/daily lane.
}

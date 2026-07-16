import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import type * as ChildProcess from "node:child_process";
import { beforeEach } from "vitest";
import {
	__setToolModuleLoadProbeBaselineForTesting,
	type ToolModuleLoadProbe,
} from "../../src/server/agent/tool-extension-preflight.js";
import { prepareGitTemplate } from "./git-template.js";

const DISABLE_ENV = "BOBBIT_TIER1_SPAWN_GUARD_DISABLE";
const STATE_KEY = Symbol.for("bobbit.tests2.tier1-spawn-guard-state");
const GUARDED_APIS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
type GuardedApi = (typeof GUARDED_APIS)[number];
type ChildProcessModule = typeof ChildProcess;
type GuardTarget = Record<GuardedApi, unknown>;

interface GuardState {
	installed: boolean;
	originals?: Record<GuardedApi, unknown>;
}

export interface Tier1SpawnGuardController {
	install(): () => void;
	isInstalled(): boolean;
}

type ProcessWithGuardState = NodeJS.Process & { [STATE_KEY]?: GuardState };
const childProcess = createRequire(import.meta.url)("node:child_process") as ChildProcessModule;

function state(): GuardState {
	const owner = process as ProcessWithGuardState;
	return owner[STATE_KEY] ??= { installed: false };
}

function displayExecutable(api: GuardedApi, firstArgument: unknown): string {
	if (typeof firstArgument !== "string" || firstArgument.trim() === "") return "<unknown>";
	let executable = firstArgument;
	if (api === "exec" || api === "execSync") {
		const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(firstArgument);
		executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? firstArgument;
	}
	return basename(executable) || executable;
}

function blocked(api: GuardedApi, firstArgument: unknown): never {
	const executable = displayExecutable(api, firstArgument);
	throw new Error(
		`[tests2/tier1-spawn-guard] blocked child_process.${api} executable=${JSON.stringify(executable)}. ` +
		"Tier-1 tests must inject a commandRunner/gitRunner fake or copy the prebuilt repository with copyGitTemplate(); " +
		"unavoidable bootstrap commands belong in runFixtureCommand() before this guard is installed.",
	);
}

function installOnTarget(target: GuardTarget, shared: GuardState, syncExports: () => void): () => void {
	if (shared.installed) return () => {};
	const originals = {} as Record<GuardedApi, unknown>;
	for (const api of GUARDED_APIS) originals[api] = target[api];
	shared.originals = originals;
	shared.installed = true;

	for (const api of GUARDED_APIS) target[api] = (...args: unknown[]) => blocked(api, args[0]);
	// Built-in ESM named exports are live only after explicitly syncing mutations
	// made through the CommonJS facade. This catches imports made before setup too.
	syncExports();

	let restored = false;
	return () => {
		if (restored || !shared.installed || shared.originals !== originals) return;
		restored = true;
		for (const api of GUARDED_APIS) target[api] = originals[api];
		shared.originals = undefined;
		shared.installed = false;
		syncExports();
	};
}

/** Create an isolated guard around an injectable target for subprocess-free tests. */
export function createTier1SpawnGuardController(target: GuardTarget, syncExports: () => void = () => {}): Tier1SpawnGuardController {
	const shared: GuardState = { installed: false };
	return {
		install: () => installOnTarget(target, shared, syncExports),
		isInstalled: () => shared.installed,
	};
}

/** Install the process-wide tier-1 subprocess fence. Repeated installs are harmless. */
export function installTier1SpawnGuard(): () => void {
	return installOnTarget(childProcess as unknown as GuardTarget, state(), syncBuiltinESMExports);
}

/** True when this fork has activated the tier-1 subprocess fence. */
export function isTier1SpawnGuardInstalled(): boolean {
	return state().installed;
}

const tier1ModuleLoadProbe: ToolModuleLoadProbe = () => undefined;

/**
 * Accept extensions after the in-process import-graph checks in tier 1.
 * Runtime module execution remains production's default outside this setup.
 */
export function installTier1ToolModuleLoadProbe(): void {
	__setToolModuleLoadProbeBaselineForTesting(tier1ModuleLoadProbe);
}

// Vitest loads this module as a setup file. Install the no-spawn preflight
// baseline immediately and before every test: isolate:false files share module
// state, while focused resilience tests may temporarily install an override.
// Build the one allowed git template before closing every subprocess API.
if (process.env[DISABLE_ENV] !== "1") {
	installTier1ToolModuleLoadProbe();
	beforeEach(installTier1ToolModuleLoadProbe);
	await prepareGitTemplate();
	installTier1SpawnGuard();
}

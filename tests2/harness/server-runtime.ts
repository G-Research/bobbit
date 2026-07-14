import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ServerTestRuntime {
	server: typeof import("../../src/server/server.js");
	aigwManager: typeof import("../../src/server/agent/aigw-manager.js");
	bobbitDir: typeof import("../../src/server/bobbit-dir.js");
	scaffold: typeof import("../../src/server/scaffold.js");
	authToken: typeof import("../../src/server/auth/token.js");
	oauth: typeof import("../../src/server/auth/oauth.js");
	packStore: typeof import("../../src/server/extension-host/pack-store.js");
	costTracker: typeof import("../../src/server/agent/cost-tracker.js");
	sessionManager: typeof import("../../src/server/agent/session-manager.js");
	sandboxToken: typeof import("../../src/server/auth/sandbox-token.js");
	gateDiagnosticsCleanup: typeof import("../../src/server/agent/gate-diagnostics-cleanup.js");
	serverHostApi: typeof import("../../src/server/extension-host/server-host-api.js");
	dockerArgs: typeof import("../../src/server/agent/docker-args.js");
	rpcBridge: typeof import("../../src/server/agent/rpc-bridge.js");
	sessionStore: typeof import("../../src/server/agent/session-store.js");
	deletionTombstones: typeof import("../../src/server/agent/deletion-tombstones.js");
	gateStore: typeof import("../../src/server/agent/gate-store.js");
	gateVerificationSnapshot: typeof import("../../src/server/gate-verification-snapshot.js");
	verificationHarness: typeof import("../../src/server/agent/verification-harness.js");
	projectRegistry: typeof import("../../src/server/agent/project-registry.js");
	titleGenerator: typeof import("../../src/server/agent/title-generator.js");
	mcpManager: typeof import("../../src/server/mcp/mcp-manager.js");
	sandboxGuard: typeof import("../../src/server/auth/sandbox-guard.js");
	resolveSkillExpansions: typeof import("../../src/server/skills/resolve-skill-expansions.js");
	slashSkills: typeof import("../../src/server/skills/slash-skills.js");
	skillManifest: typeof import("../../src/server/skills/skill-manifest.js");
	staffManager: typeof import("../../src/server/agent/staff-manager.js");
	compactionSidecar: typeof import("../../src/server/agent/compaction-sidecar.js");
}

let runtimePromise: Promise<ServerTestRuntime> | undefined;

async function loadSourceRuntime(): Promise<ServerTestRuntime> {
	return import("./server-runtime-entry.js") as Promise<ServerTestRuntime>;
}

export function serverRuntimeMode(): "bundle" | "source" {
	const bundle = process.env.BOBBIT_V2_SERVER_PREBUNDLE;
	return bundle && existsSync(bundle) ? "bundle" : "source";
}

export function loadServerTestRuntime(): Promise<ServerTestRuntime> {
	if (!runtimePromise) {
		const bundle = process.env.BOBBIT_V2_SERVER_PREBUNDLE;
		if (bundle) {
			if (!existsSync(bundle)) throw new Error(`[tests2/server-runtime] configured prebundle does not exist: ${bundle}`);
			runtimePromise = import(/* @vite-ignore */ pathToFileURL(bundle).href) as Promise<ServerTestRuntime>;
		} else {
			runtimePromise = loadSourceRuntime();
		}
	}
	return runtimePromise;
}

export function resetServerTestRuntimeForTests(): void {
	runtimePromise = undefined;
}

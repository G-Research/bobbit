import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SESSION_MANAGER = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-manager.ts"), "utf-8");
const SESSION_LIVE_CONTROL = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-live-control.ts"), "utf-8");
const SESSION_SETUP_PLUMBING = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-setup-plumbing.ts"), "utf-8");
const SESSION_SPAWN = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-spawn.ts"), "utf-8");
const SESSION_REVIVE = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-revive.ts"), "utf-8");
const RPC_BRIDGE = fs.readFileSync(path.join(process.cwd(), "src/server/agent/rpc-bridge.ts"), "utf-8");

function methodBody(source: string, name: string): string {
	const classStart = source.indexOf("export class SessionSetupPlumbing");
	const searchStart = classStart >= 0 ? classStart : 0;
	const asyncStart = source.indexOf(`\n\tasync ${name}(`, searchStart);
	const plainStart = source.indexOf(`\n\t${name}(`, searchStart);
	const start = asyncStart >= 0 ? asyncStart + 2 : (plainStart >= 0 ? plainStart + 2 : -1);
	assert.ok(start >= 0, `${name} must exist`);
	let next = source.indexOf("\n\t/**", start + name.length);
	if (next === -1) next = source.indexOf("\n}\n\n//", start + name.length);
	assert.ok(next > start, `${name} body must have a following method/comment boundary`);
	return source.slice(start, next);
}

describe("session-manager sandbox scope regressions", () => {
	it("direct gateway env never falls back to readToken/admin token", () => {
		assert.doesNotMatch(RPC_BRIDGE, /import \{ readToken \} from "\.\.\/auth\/token\.js"/);
		const bodyStart = RPC_BRIDGE.indexOf("export function resolveDirectGatewayEnv(");
		assert.ok(bodyStart >= 0, "resolveDirectGatewayEnv must exist");
		const body = RPC_BRIDGE.slice(bodyStart, RPC_BRIDGE.indexOf("\nexport function buildAgentArgs", bodyStart));
		assert.doesNotMatch(body, /readToken\(/, "direct child env must not read the admin token");
		assert.match(body, /if \(opts\.gatewayToken\) env\.BOBBIT_TOKEN = opts\.gatewayToken;/);
	});

	it("applySandboxWiring uses the selected project config before checking sandbox", () => {
		const body = methodBody(SESSION_SETUP_PLUMBING, "applySandboxWiring");
		const contextIdx = body.indexOf("const projectContext = projectContextManager?.getOrCreate(projectId) ?? null;");
		const configIdx = body.indexOf("const projectConfigStore = projectContext?.projectConfigStore ?? this.deps.getProjectConfigStore();");
		const sandboxIdx = body.indexOf("const sandboxConfig = projectConfigStore.get(\"sandbox\") || \"none\";");
		assert.ok(contextIdx >= 0 && configIdx > contextIdx && sandboxIdx > configIdx, "selected project config must drive sandbox mode");
		assert.doesNotMatch(body.slice(0, sandboxIdx), /this\.projectConfigStore\.get\("sandbox"\)/);
	});

	it("Headquarters/system scopes are forced out of sandbox at the session-manager boundary", () => {
		assert.match(SESSION_SETUP_PLUMBING, /import \{ isSandboxExemptProject, type SandboxManager \} from "\.\/sandbox-manager\.js";/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "applySandboxWiring"), /if \(isSandboxExemptProject\(projectId\)\) \{[\s\S]*?bridgeOptions\.sandboxed = false;[\s\S]*?return false;/);
		assert.match(SESSION_SPAWN, /const effectiveSandboxed = opts\?\.sandboxed && !sandboxExemptScope \? true : undefined;/);
		assert.match(SESSION_REVIVE, /let restoredSandboxed = ps\.sandboxed === true && !\(ps\.projectId && isSandboxExemptProject\(ps\.projectId\)\);/);
	});

	it("force-abort respawn honors a false sandbox wiring result", () => {
		assert.match(SESSION_LIVE_CONTROL, /const sandboxApplied = await this\.applySandboxWiring\(bridgeOptions, id, \{/);
		assert.match(SESSION_LIVE_CONTROL, /if \(!sandboxApplied\) \{[\s\S]*?session\.sandboxed = false;[\s\S]*?update\(id, \{ sandboxed: false \}\);/);
	});

	it("direct agents receive scoped gateway credentials from session-manager", () => {
		assert.match(SESSION_SETUP_PLUMBING, /mintScopedGatewayToken\([\s\S]*?sandboxTokenStore\.register\(projectId\)[\s\S]*?addSession\(projectId, sessionId\)/);
		assert.match(SESSION_SPAWN, /const directGatewayEnv = !effectiveSandboxed[\s\S]*?this\.scopedGatewayEnvForDirectAgent\(id, projectId/);
		assert.match(SESSION_SPAWN, /env: \{ \.\.\.\(opts\?\.env \?\? \{\}\), \.\.\.\(directGatewayEnv \?\? \{\}\) \}/);
		assert.match(SESSION_MANAGER, /if \(!session\.sandboxed\) this\.applyScopedGatewayCredentials\(bridgeOptions, id, session\.projectId/);
	});

	it("session setup plumbing retains moved body comments and distinctive setup/sandbox fragments", () => {
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "readClaudeCodeConfigForProject"), /readClaudeCodeConfig\(preferencesStore, projectConfigStore\)/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "buildPipelineContext"), /Dark by default \(BOBBIT_WARM_POOL=1 opts in\)/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "buildPipelineContext"), /resolveGoalMetadata: \(goalId: string \| undefined\) => resolvedGoalManager\.getEffectiveGoalMetadata\(goalId\)/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "ensureSandboxNetwork"), /sandboxNetworkCreateArgs\(name\)/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "cleanupSandboxNetwork"), /Removed Docker network/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "resolveSandboxCwdOffset"), /Prefer the goal's stable repo\/worktree metadata when available/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "readGatewayUrlForAgent"), /path\.join\(bobbitStateDir\(\), "gateway-url"\)/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "applyScopedGatewayCredentials"), /bridgeOptions\.gatewayToken = scopedToken/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "scopedGatewayEnvForDirectAgent"), /env\.BOBBIT_GATEWAY_URL = gwUrl/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "applySandboxWiring"), /Capture the HOST-side working directory BEFORE it is remapped/);
		assert.match(methodBody(SESSION_SETUP_PLUMBING, "applySandboxWiring"), /resolveSandboxAgentAuthPolicy\(sandboxTokenEntries\)/);
		assert.match(SESSION_SETUP_PLUMBING, /Resolve sandbox tokens from the unified sandbox_tokens config key/);
		assert.match(SESSION_SETUP_PLUMBING, /Legacy credential resolution from sandbox_credentials \+ sandbox_host_token_overrides \+ sandbox_github_token/);
	});
});

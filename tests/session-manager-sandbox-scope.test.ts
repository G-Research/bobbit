import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SESSION_MANAGER = fs.readFileSync(path.join(process.cwd(), "src/server/agent/session-manager.ts"), "utf-8");
const RPC_BRIDGE = fs.readFileSync(path.join(process.cwd(), "src/server/agent/rpc-bridge.ts"), "utf-8");

function methodBody(name: string): string {
	const marker = `private async ${name}(`;
	const start = SESSION_MANAGER.indexOf(marker);
	assert.ok(start >= 0, `${name} must exist`);
	const next = SESSION_MANAGER.indexOf("\n\t/**", start + marker.length);
	assert.ok(next > start, `${name} body must have a following method/comment boundary`);
	return SESSION_MANAGER.slice(start, next);
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
		const body = methodBody("applySandboxWiring");
		const contextIdx = body.indexOf("const projectContext = this.projectContextManager?.getOrCreate(projectId) ?? null;");
		const configIdx = body.indexOf("const projectConfigStore = projectContext?.projectConfigStore ?? this.projectConfigStore;");
		const sandboxIdx = body.indexOf("const sandboxConfig = projectConfigStore.get(\"sandbox\") || \"none\";");
		assert.ok(contextIdx >= 0 && configIdx > contextIdx && sandboxIdx > configIdx, "selected project config must drive sandbox mode");
		assert.doesNotMatch(body.slice(0, sandboxIdx), /this\.projectConfigStore\.get\("sandbox"\)/);
	});

	it("Headquarters/system scopes are forced out of sandbox at the session-manager boundary", () => {
		assert.match(SESSION_MANAGER, /import \{ isSandboxExemptProject, type SandboxManager \} from "\.\/sandbox-manager\.js";/);
		assert.match(methodBody("applySandboxWiring"), /if \(isSandboxExemptProject\(projectId\)\) \{[\s\S]*?bridgeOptions\.sandboxed = false;[\s\S]*?return false;/);
		assert.match(SESSION_MANAGER, /const effectiveSandboxed = opts\?\.sandboxed && !sandboxExemptScope \? true : undefined;/);
		assert.match(SESSION_MANAGER, /let restoredSandboxed = ps\.sandboxed === true && !\(ps\.projectId && isSandboxExemptProject\(ps\.projectId\)\);/);
	});

	it("force-abort respawn honors a false sandbox wiring result", () => {
		assert.match(SESSION_MANAGER, /const sandboxApplied = await this\.applySandboxWiring\(bridgeOptions, id, \{/);
		assert.match(SESSION_MANAGER, /if \(!sandboxApplied\) \{[\s\S]*?session\.sandboxed = false;[\s\S]*?update\(id, \{ sandboxed: false \}\);/);
	});

	it("direct agents receive scoped gateway credentials from session-manager", () => {
		assert.match(SESSION_MANAGER, /private mintScopedGatewayToken\([\s\S]*?this\.sandboxTokenStore\.register\(projectId\)[\s\S]*?addSession\(projectId, sessionId\)/);
		assert.match(SESSION_MANAGER, /const directGatewayEnv = !effectiveSandboxed[\s\S]*?this\.scopedGatewayEnvForDirectAgent\(id, projectId/);
		assert.match(SESSION_MANAGER, /env: \{ \.\.\.\(opts\?\.env \?\? \{\}\), \.\.\.\(directGatewayEnv \?\? \{\}\) \}/);
		assert.match(SESSION_MANAGER, /if \(!session\.sandboxed\) this\.applyScopedGatewayCredentials\(bridgeOptions, id, session\.projectId/);
	});
});

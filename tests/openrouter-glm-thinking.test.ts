import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("openrouter-glm-thinking-");
const stateDir = path.join(tmpRoot, "state");
const agentDir = path.join(tmpRoot, "agent");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;
process.env.BOBBIT_AGENT_DIR = agentDir;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const { getAvailableModels, invalidateModelCache } = await import("../src/server/agent/model-registry.ts");
const { clampThinkingLevelForModel } = await import("../src/server/agent/thinking-level-clamp.ts");

const managers: any[] = [];

afterEach(() => {
	invalidateModelCache();
	while (managers.length > 0) {
		const manager = managers.pop();
		if (manager?._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager?.sessions?.clear?.();
	}
});

function prefsFor(model: string, thinkingLevel = "high"): any {
	const dir = fs.mkdtempSync(path.join(stateDir, "prefs-"));
	const prefs = new PreferencesStore(dir);
	prefs.set("default.sessionModel", model);
	prefs.set("default.sessionThinkingLevel", thinkingLevel);
	return prefs;
}

async function withAigwServer(models: unknown[], run: (baseUrl: string) => Promise<void>): Promise<void> {
	const server = http.createServer((req, res) => {
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: models }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
	}
}

describe("OpenRouter/AIGW GLM 5.x thinking clamp", () => {
	it("spawn-time initial thinking resolution keeps high for openrouter/z-ai/glm-5.2", () => {
		const manager: any = new SessionManager({ preferencesStore: prefsFor("openrouter/z-ai/glm-5.2", "high") });
		managers.push(manager);

		assert.equal(manager.resolveInitialThinkingLevel(undefined, undefined), "high");
	});

	it("spawn-time initial thinking resolution keeps high for aigw/z-ai/glm-5.2", () => {
		const manager: any = new SessionManager({ preferencesStore: prefsFor("aigw/z-ai/glm-5.2", "high") });
		managers.push(manager);

		assert.equal(manager.resolveInitialThinkingLevel(undefined, undefined), "high");
	});

	it("spawn-time initial thinking resolution still clamps older GLM families to off", () => {
		for (const model of ["openrouter/z-ai/glm-4.5", "aigw/z-ai/glm-4.5"]) {
			const manager: any = new SessionManager({ preferencesStore: prefsFor(model, "high") });
			managers.push(manager);

			assert.equal(manager.resolveInitialThinkingLevel(undefined, undefined), "off", `${model} should remain non-reasoning`);
		}
	});

	it("runtime persisted OpenRouter and AIGW GLM 5.2 clamps accept high", () => {
		for (const provider of ["openrouter", "aigw"]) {
			assert.equal(clampThinkingLevelForModel("high", provider, "z-ai/glm-5.2"), "high", `${provider} GLM 5.2 high should stay high`);
			assert.equal(clampThinkingLevelForModel("xhigh", provider, "z-ai/glm-5.2"), "high", `${provider} GLM 5.2 xhigh should clamp to high`);
		}
	});

	it("runtime persisted older GLM clamp remains non-reasoning", () => {
		for (const provider of ["openrouter", "aigw"]) {
			assert.equal(clampThinkingLevelForModel("high", provider, "z-ai/glm-4.5"), "off", `${provider} older GLM should remain non-reasoning`);
		}
	});

	it("/api/models metadata marks sparse GLM 5.2 gateway entries as reasoning-capable", async () => {
		await withAigwServer([
			{ id: "z-ai/glm-5.2", context_length: 131_072, max_tokens: 32_768 },
		], async (baseUrl) => {
			const prefs = new PreferencesStore(fs.mkdtempSync(path.join(stateDir, "aigw-prefs-")));
			prefs.set("aigw.url", baseUrl);
			invalidateModelCache();

			const models = await getAvailableModels(prefs);
			const glm = models.find((m: any) => m.provider === "aigw" && m.id === "z-ai/glm-5.2");
			assert.ok(glm, "expected z-ai/glm-5.2 in model registry output");
			assert.equal(glm.reasoning, true);
		});
	});
});

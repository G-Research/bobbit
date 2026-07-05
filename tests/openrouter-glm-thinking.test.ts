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
const { getBuiltinModel: getModel } = await import("@earendil-works/pi-ai/providers/all");
const { clampThinkingLevelForModel, resolveThinkingClampModel } = await import("../src/server/agent/thinking-level-clamp.ts");

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

	it("spawn-time initial thinking resolution follows catalog for OpenRouter but inferMeta for older AIGW GLM", () => {
		const openrouterManager: any = new SessionManager({ preferencesStore: prefsFor("openrouter/z-ai/glm-4.5", "high") });
		managers.push(openrouterManager);
		assert.equal(openrouterManager.resolveInitialThinkingLevel(undefined, undefined), "high");

		const aigwManager: any = new SessionManager({ preferencesStore: prefsFor("aigw/z-ai/glm-4.5", "high") });
		managers.push(aigwManager);
		assert.equal(aigwManager.resolveInitialThinkingLevel(undefined, undefined), "off", "older AIGW GLM should remain non-reasoning by inferMeta fallback");
	});

	it("runtime persisted OpenRouter GLM 5.2 clamp uses pi-ai catalog metadata", () => {
		const catalogModel = getModel("openrouter" as any, "z-ai/glm-5.2") as any;
		assert.equal(catalogModel?.reasoning, true, "pi-ai catalog should mark OpenRouter GLM 5.2 as reasoning-capable");

		const resolved = resolveThinkingClampModel("openrouter", "z-ai/glm-5.2");
		assert.equal(resolved.metadataSource, "pi-ai-catalog");
		assert.equal(resolved.reasoning, true);
		assert.equal(clampThinkingLevelForModel("high", "openrouter", "z-ai/glm-5.2"), "high");
		// pi-ai 0.80 added `thinkingLevelMap: { xhigh: "xhigh" }` for this catalog
		// entry (0.79.6 had none, so "xhigh" clamped down to "high"). The model
		// now genuinely advertises xhigh support, so it must pass through
		// unclamped — same code path pinned below by the synthetic
		// "vendor/future-reasoner" xhigh-support test.
		assert.equal(clampThinkingLevelForModel("xhigh", "openrouter", "z-ai/glm-5.2"), "xhigh");
	});

	it("runtime persisted AIGW GLM 5.2 clamp keeps inferMeta fallback", () => {
		const throwingCatalogLookup = () => {
			throw new Error("AIGW must not consult the built-in catalog");
		};
		const resolved = resolveThinkingClampModel("aigw", "z-ai/glm-5.2", { catalogLookup: throwingCatalogLookup });
		assert.equal(resolved.metadataSource, "inferMeta");
		assert.equal(resolved.reasoning, true);
		assert.equal(clampThinkingLevelForModel("high", "aigw", "z-ai/glm-5.2", { catalogLookup: throwingCatalogLookup }), "high");
		assert.equal(clampThinkingLevelForModel("xhigh", "aigw", "z-ai/glm-5.2", { catalogLookup: throwingCatalogLookup }), "high");
	});

	it("catalog thinkingLevelMap metadata is passed through to xhigh support", () => {
		const catalogLookup = () => ({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" as const } });
		const resolved = resolveThinkingClampModel("openrouter", "vendor/future-reasoner", { catalogLookup });
		assert.equal(resolved.metadataSource, "pi-ai-catalog");
		assert.deepEqual(resolved.thinkingLevelMap, { xhigh: "xhigh" });
		assert.equal(clampThinkingLevelForModel("xhigh", "openrouter", "vendor/future-reasoner", { catalogLookup }), "xhigh");
	});

	it("runtime persisted older GLM clamp follows catalog for OpenRouter but inferMeta for AIGW", () => {
		const catalogModel = getModel("openrouter" as any, "z-ai/glm-4.5") as any;
		assert.equal(catalogModel?.reasoning, true, "pi-ai catalog should drive built-in OpenRouter metadata when present");
		assert.equal(clampThinkingLevelForModel("high", "openrouter", "z-ai/glm-4.5"), "high");
		assert.equal(clampThinkingLevelForModel("high", "aigw", "z-ai/glm-4.5"), "off", "older AIGW GLM should remain non-reasoning by inferMeta fallback");
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

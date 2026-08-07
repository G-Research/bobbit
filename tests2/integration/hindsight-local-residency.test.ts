import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packRoot = path.join(root, "market-packs", "hindsight");
const settingsPath = path.join(packRoot, "src", "runtime-settings.ts");
const routesPath = path.join(packRoot, "src", "memory-routes.ts");
const bridgePath = path.join(root, "src", "server", "agent", "hindsight-runtime-bridge.ts");
const implemented = fs.existsSync(settingsPath) && fs.existsSync(routesPath) && fs.existsSync(bridgePath);

function source(file: string): string {
	return fs.readFileSync(file, "utf8");
}

/** The real local/Docker/Compose matrix owns model-process startup. This
 * integration boundary pins what the gateway must retain across two sequential
 * route operations: a redacted resident load identity, no paid fallback, and a
 * finite down/unhealthy result without an implicit recovery/start. */
describe.skipIf(!implemented)("Hindsight local resident model integration", () => {
	it("keeps one safe resident-load witness across sequential retain and reflect adapters", () => {
		const settings = source(settingsPath);
		const routes = source(routesPath);
		const bridge = source(bridgePath);
		const combined = `${settings}\n${routes}\n${bridge}`;

		assert.match(settings, /localLlmResidency[\s\S]{0,200}resident/, "EP-7 must default local inference to resident");
		assert.match(settings, /observedLoadId/, "only a safe model-load witness may be projected after explicit start");
		assert.match(settings, /localLlmKeepAlive/, "residency must survive a sequential retain/reflect pair rather than unloading per request");
		assert.match(routes, /["']retain["']/, "the first operation must use the common typed retain adapter");
		assert.match(routes, /["']reflect["']/, "the second operation must use the common typed reflect adapter");
		assert.match(bridge, /observedLoadId|loadId|resident/i, "the live runtime bridge must carry a single model process/load identity");
		assert.doesNotMatch(combined, /(?:retain|reflect)[\s\S]{0,500}(?:spawn|start)[A-Z_a-z]*(?:model|llm)/i,
			"data-plane retain/reflect may observe an already-resident model but must not start a new model process per call");
	});

	it("requires no fake loopback key and degrades local down or unhealthy calls without fallback", () => {
		const settings = source(settingsPath);
		const routes = source(routesPath);
		const bridge = source(bridgePath);
		const combined = `${settings}\n${routes}\n${bridge}`;

		assert.match(settings, /isLoopbackHttpEndpoint/, "a loopback endpoint needs an explicit no-key path");
		assert.match(settings, /127(?:\\\.\d\{1,3\})\{3\}|localhost/, "the loopback rule must cover local OpenAI-compatible services");
		assert.match(settings, /HINDSIGHT_LOCAL_API_KEY_REQUIRED/, "non-loopback endpoints must still require a write-only key at explicit start");
		assert.match(routes, /SERVICE_UNHEALTHY|SERVICE_UNAVAILABLE/, "unhealthy data-plane results must be discriminated rather than hang");
		assert.match(routes, /AbortSignal|signal|deadline|timeout/i, "route work needs a finite cancellation/deadline boundary");
		assert.match(bridge, /AbortSignal|signal|deadline|timeout/i, "runtime status/control must not wait for automatic recovery");
		assert.doesNotMatch(combined, /fallback[^\n]*(?:external|paid)|(?:external|paid)[^\n]*fallback/i,
			"an unhealthy local model must never select an external or paid provider");
		assert.doesNotMatch(combined, /(?:apiKey|localLlmApiKey|registryCredentials|externalDatabaseUrl)[^\n]*(?:status|diagnostic|log)/i,
			"resident diagnostics and failure results must never echo secrets");
	});
});

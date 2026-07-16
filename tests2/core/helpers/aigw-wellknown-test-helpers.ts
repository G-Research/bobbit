import { guardProcessEnv } from "./env-guard.js";
guardProcessEnv();

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "..", "fixtures", "wellknown-opencode.json");

export const {
	translateWellKnown,
	writeAigwModelsJson,
	discoverAigwModels,
	configureAigw,
	seedDefaultModelsFromWellKnown,
	configureAigwRuntimeFlags,
	normalizeAigwModelString,
	fetchWellKnownConfig,
	normalizeAigwPricing,
	normalizeWellKnownCost,
	createAigwGuardedLookup,
	collectAigwProviderDnsHosts,
	filterValidatedProviderUrls,
	getAigwProviderDnsGuardHosts,
	replaceAigwProviderDnsGuardHosts,
	removeAigw,
	writeAigwDnsGuardExtension,
} = await import("../../../src/server/agent/aigw-manager.ts");
export const { resetAgentDirStateForTests } = await import("../../../src/server/bobbit-dir.js");

export function loadFixture(): any {
	return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
}

export const GATEWAY = "http://aigw-local.t3.zone";

export function byId(models: any[], id: string): any {
	return models.find((model) => (model.wireId ?? model.id) === id || model.id === id);
}

export function startDiscoveryServer(
	handler: (req: http.IncomingMessage, res: http.ServerResponse, origin: string) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => handler(req, res, `http://127.0.0.1:${(server.address() as any).port}`));
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
		origin: `http://127.0.0.1:${(server.address() as any).port}`,
		close: () => new Promise<void>((done) => server.close(() => done())),
	})));
}

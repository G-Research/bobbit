/**
 * E2E for the gateway_api tool — drives the captured execute() against the
 * harness's live in-process gateway and verifies a real /api/sessions round-trip.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken } from "./e2e-setup.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

interface CapturedTool {
	name: string;
	execute: (toolCallId: string, params: any) => Promise<any>;
}

async function loadGatewayApiTool(gatewayUrl: string, token: string): Promise<CapturedTool["execute"]> {
	process.env.BOBBIT_GATEWAY_URL = gatewayUrl;
	process.env.BOBBIT_TOKEN = token;
	const file = path.join(REPO_ROOT, "defaults/tools/agent/extension.ts");
	const url = pathToFileURL(file).href;
	const mod: any = await import(url);
	const factory = typeof mod.default === "function" ? mod.default : mod.default?.default;
	const captured: CapturedTool[] = [];
	const pi = {
		registerTool(def: any) { captured.push({ name: def.name, execute: def.execute }); },
		on() {},
	};
	factory(pi);
	const tool = captured.find((t) => t.name === "gateway_api");
	if (!tool) throw new Error("gateway_api tool was not registered");
	return tool.execute;
}

test("gateway_api round-trips GET /api/sessions against the live gateway", async ({ gateway }) => {
	const token = readE2EToken();
	const execute = await loadGatewayApiTool(gateway.baseURL, token);

	const result = await execute("t-e2e-1", { method: "GET", path: "/api/sessions" });

	expect(result.isError).toBeUndefined();
	expect(result.content?.[0]?.text).toBeTruthy();
	const parsed = JSON.parse(result.content[0].text);
	expect(parsed.status).toBe(200);
	// /api/sessions returns { generation, sessions[], archivedDelegates[] }
	expect(typeof parsed.body).toBe("object");
	expect(Array.isArray(parsed.body.sessions)).toBe(true);
});

test("gateway_api rejects non-/api/ paths without touching the network", async ({ gateway }) => {
	const token = readE2EToken();
	const execute = await loadGatewayApiTool(gateway.baseURL, token);

	const result = await execute("t-e2e-2", { method: "GET", path: "/etc/passwd" });
	expect(result.isError).toBe(true);
	expect(result.content[0].text).toMatch(/must start with \/api\//);
});

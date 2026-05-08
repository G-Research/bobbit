/**
 * E2E test: x-opencode-session header end-to-end through the AI Gateway
 * configure flow.
 *
 * ─── De-scoping note ────────────────────────────────────────────────
 * The design doc lists four scenarios that require capturing actual
 * upstream LLM requests from a spawned agent CLI subprocess:
 *   (1) two sessions → two distinct header values,
 *   (2) header omitted when env unset,
 *   (3) Claude (Bedrock) routing unaffected,
 *   (4) header value persists across server restart.
 *
 * Wiring those scenarios in-process is infeasible without modifying
 * `pi-coding-agent` / `pi-ai` (explicitly out of scope) — the REST E2E
 * harness doesn't fire real LLM calls. Those four scenarios live in
 * `tests/manual-integration/` (manual smoke against `tools/dummy-aigw`)
 * and are also covered structurally by:
 *   - `tests/aigw-headers.test.ts` (unit) — proves the literal lands in
 *     models.json at the provider level, on the aigw provider only.
 *   - `tests/aigw-header-resolver.test.ts` (behavioural) — proves the
 *     literal `node -e "..."` command round-trips through the host
 *     shell with the documented "omit on empty" semantics.
 *   - `tests/spawn-env.test.ts` (unit) — proves the spawn path always
 *     seeds `BOBBIT_SESSION_ID` for the agent subprocess.
 *
 * This E2E exercises the configure-aigw REST flow end-to-end and asserts
 * the resulting on-disk `models.json` carries the expected provider-level
 * header literal — a layer the unit test cannot reach because it bypasses
 * the REST handler.
 */

import { test, expect } from "./in-process-harness.js";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { apiFetch } from "./e2e-setup.js";

const EXPECTED_HEADER_VALUE =
	`!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;

const MOCK_MODELS = {
	data: [
		{ id: "openai/gpt-5.2", object: "model", created: 1700000000, owned_by: "system" },
		{ id: "aws/us.anthropic.claude-sonnet-4-6", object: "model", created: 1700000000, owned_by: "system" },
	],
};

function getModelsJsonPath(): string {
	const envDir = process.env.BOBBIT_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
	let agentDir: string;
	if (envDir) {
		if (envDir === "~") agentDir = homedir();
		else if (envDir.startsWith("~/")) agentDir = homedir() + envDir.slice(1);
		else agentDir = envDir;
	} else {
		// Default is now <BOBBIT_DIR>/state/agent (per goal: relocate agent dir under server cwd).
		const bobbitDir = process.env.BOBBIT_DIR;
		if (bobbitDir) {
			agentDir = join(bobbitDir, "state", "agent");
		} else {
			agentDir = join(homedir(), ".bobbit", "agent");
		}
	}
	return join(agentDir, "models.json");
}

let mockServer: http.Server;
let mockPort: number;

test.beforeAll(async () => {
	mockServer = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(MOCK_MODELS));
	});
	await new Promise<void>((resolve) => {
		mockServer.listen(0, "127.0.0.1", () => {
			mockPort = (mockServer.address() as any).port;
			resolve();
		});
	});
});

test.afterAll(async () => {
	mockServer?.close();
});

test.afterEach(async () => {
	await apiFetch("/api/aigw/configure", { method: "DELETE" });
});

test.describe("aigw x-opencode-session header (configure flow)", () => {
	test("configure writes provider-level x-opencode-session header to models.json", async () => {
		const configureRes = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		expect(configureRes.status).toBe(200);

		const modelsPath = getModelsJsonPath();
		expect(existsSync(modelsPath)).toBe(true);

		const data = JSON.parse(readFileSync(modelsPath, "utf-8"));
		const aigw = data.providers?.aigw;
		expect(aigw, "aigw provider must exist after configure").toBeTruthy();
		expect(aigw.headers, "aigw provider must carry a headers block").toBeTruthy();
		expect(aigw.headers["x-opencode-session"]).toBe(EXPECTED_HEADER_VALUE);
	});

	test("header is NOT placed on individual model entries", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		const data = JSON.parse(readFileSync(getModelsJsonPath(), "utf-8"));
		const models = data.providers.aigw.models;
		expect(Array.isArray(models)).toBe(true);
		for (const m of models) {
			expect(m.headers, `model ${m.id} must NOT carry a per-model headers field`).toBeUndefined();
		}
	});

	test("DELETE removes the aigw provider (and its headers) cleanly", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});
		const delRes = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(delRes.status).toBe(200);

		const data = JSON.parse(readFileSync(getModelsJsonPath(), "utf-8"));
		expect(data.providers.aigw, "aigw block must be gone").toBeUndefined();
	});

	test("non-aigw providers do NOT receive the x-opencode-session header", async () => {
		await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url: `http://127.0.0.1:${mockPort}` }),
		});

		const data = JSON.parse(readFileSync(getModelsJsonPath(), "utf-8"));
		for (const [name, provider] of Object.entries<any>(data.providers || {})) {
			if (name === "aigw") continue;
			const hdrs = provider?.headers;
			if (hdrs) {
				expect(hdrs["x-opencode-session"], `provider ${name} must not carry x-opencode-session`).toBeUndefined();
			}
		}
	});
});

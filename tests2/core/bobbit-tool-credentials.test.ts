// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Credential/URL resolution for the bobbit extension: env creds, state-file
// fallback, absent-creds (logs + no registration, no throw), and baseUrl
// trailing-slash trimming.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBobbitTools, stubFetch } from "./helpers/bobbit-harness.ts";

function clearCreds() {
	delete process.env.BOBBIT_TOKEN;
	delete process.env.BOBBIT_GATEWAY_URL;
	delete process.env.BOBBIT_DIR;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("bobbit extension — credential resolution", () => {
	it("registers all three tools when env creds are present", () => {
		clearCreds();
		process.env.BOBBIT_TOKEN = "tok";
		process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
		const tools = loadBobbitTools();
		expect([...tools.keys()].sort()).toEqual(["bobbit_admin", "bobbit_orchestrate", "bobbit_read"]);
	});

	it("falls back to state files when env creds are absent", () => {
		clearCreds();
		const dir = mkdtempSync(path.join(tmpdir(), "bobbit-creds-"));
		mkdirSync(path.join(dir, "state"), { recursive: true });
		writeFileSync(path.join(dir, "state", "token"), "file-token\n");
		writeFileSync(path.join(dir, "state", "gateway-url"), "https://gw.files\n");
		process.env.BOBBIT_DIR = dir;
		const tools = loadBobbitTools();
		expect(tools.size).toBe(3);
	});

	it("registers nothing and logs when creds cannot be resolved (no throw)", () => {
		clearCreds();
		const emptyDir = mkdtempSync(path.join(tmpdir(), "bobbit-nocreds-"));
		process.env.BOBBIT_DIR = emptyDir; // state/token does not exist
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let tools: Map<string, unknown> | undefined;
		expect(() => {
			tools = loadBobbitTools();
		}).not.toThrow();
		expect(tools!.size).toBe(0);
		expect(errSpy).toHaveBeenCalledWith(
			"[bobbit-tools] Cannot read gateway credentials — tools not registered",
		);
	});

	it("trims trailing slashes from the gateway base URL", async () => {
		clearCreds();
		process.env.BOBBIT_TOKEN = "tok";
		process.env.BOBBIT_GATEWAY_URL = "https://gw.test///";
		const tools = loadBobbitTools();
		const calls = stubFetch();
		await tools.get("bobbit_read")!.execute("id", { operation: "health" });
		expect(calls[0].url).toBe("https://gw.test/api/health");
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tasksExtension from "../../../defaults/tools/tasks/extension.js";

const previousEnv = {
	BOBBIT_SESSION_ID: process.env.BOBBIT_SESSION_ID,
	BOBBIT_SESSION_SECRET: process.env.BOBBIT_SESSION_SECRET,
	BOBBIT_GOAL_ID: process.env.BOBBIT_GOAL_ID,
	BOBBIT_TOKEN: process.env.BOBBIT_TOKEN,
	BOBBIT_GATEWAY_URL: process.env.BOBBIT_GATEWAY_URL,
};
const originalFetch = globalThis.fetch;
const temporaryPaths: string[] = [];

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const temporaryPath of temporaryPaths.splice(0)) {
		fs.rmSync(temporaryPath, { recursive: true, force: true });
	}
});

function registerVerificationResult(): any {
	Object.assign(process.env, {
		BOBBIT_SESSION_ID: "verifier-session",
		BOBBIT_SESSION_SECRET: "verifier-secret",
		BOBBIT_GOAL_ID: "goal-1",
		BOBBIT_TOKEN: "sandbox-token",
		BOBBIT_GATEWAY_URL: "http://gateway.test",
	});
	const tools = new Map<string, any>();
	tasksExtension({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	return tools.get("verification_result");
}

describe("verification result file upload", () => {
	it("reads report_html_file in the verifier process and uploads only its bytes", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-verification-upload-"));
		temporaryPaths.push(dir);
		const reportPath = path.join(dir, "report.html");
		const reportHtml = "<!doctype html><h1>QA passed</h1>";
		fs.writeFileSync(reportPath, reportHtml);

		let postedBody: any;
		globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			postedBody = JSON.parse(String(init?.body));
			expect(init?.headers).toMatchObject({
				Authorization: "Bearer sandbox-token",
				"X-Bobbit-Session-Secret": "verifier-secret",
			});
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as typeof fetch;

		const result = await registerVerificationResult().execute("call-1", {
			verdict: "pass",
			summary: "All scenarios passed",
			report_html_file: reportPath,
		});

		expect(result.isError).not.toBe(true);
		expect(postedBody).toEqual({
			sessionId: "verifier-session",
			verdict: "pass",
			summary: "All scenarios passed",
			report_html: reportHtml,
		});
		expect(postedBody).not.toHaveProperty("report_html_file");
	});

	it("rejects non-regular report paths before making a gateway request", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-verification-upload-dir-"));
		temporaryPaths.push(dir);
		globalThis.fetch = vi.fn() as typeof fetch;

		const result = await registerVerificationResult().execute("call-2", {
			verdict: "pass",
			summary: "invalid report",
			report_html_file: dir,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("regular file");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});

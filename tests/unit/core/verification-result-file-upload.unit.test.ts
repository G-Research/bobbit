import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import tasksExtension from "../../../defaults/tools/tasks/extension.js";

const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const originalCwd = process.cwd();
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
	process.chdir(originalCwd);
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

function temporaryDirectory(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryPaths.push(dir);
	return dir;
}

function captureRequestBody(): { fetchMock: ReturnType<typeof vi.fn>; body: () => any; rawBody: () => string } {
	let postedBody: any;
	let postedRawBody = "";
	const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		postedRawBody = String(init?.body);
		postedBody = JSON.parse(postedRawBody);
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer sandbox-token",
			"X-Bobbit-Session-Secret": "verifier-secret",
		});
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	});
	globalThis.fetch = fetchMock as typeof fetch;
	return { fetchMock, body: () => postedBody, rawBody: () => postedRawBody };
}

async function submitReport(reportPath: string, callId = "file-upload"): Promise<any> {
	return registerVerificationResult().execute(callId, {
		verdict: "pass",
		summary: "All scenarios passed",
		report_html_file: reportPath,
	});
}

describe("verification result file upload", () => {
	it("uploads escape-heavy report bytes at the exact 10 MiB limit without sending a path", async () => {
		const dir = temporaryDirectory("bobbit-verification-upload-limit-");
		const reportPath = path.join(dir, "report.html");
		const reportHtml = `\\"`.repeat(MAX_REPORT_BYTES / 2);
		expect(Buffer.byteLength(reportHtml)).toBe(MAX_REPORT_BYTES);
		fs.writeFileSync(reportPath, reportHtml);
		const capture = captureRequestBody();

		const result = await submitReport(reportPath, "exact-limit");

		expect(result.isError).not.toBe(true);
		expect(capture.fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.byteLength(capture.rawBody())).toBeGreaterThan(MAX_REPORT_BYTES * 2);
		expect(capture.body()).toEqual({
			sessionId: "verifier-session",
			verdict: "pass",
			summary: "All scenarios passed",
			report_html: reportHtml,
		});
		expect(capture.body()).not.toHaveProperty("report_html_file");
	});

	it("rejects a report one byte over 10 MiB before making a gateway request", async () => {
		const dir = temporaryDirectory("bobbit-verification-upload-oversized-");
		const reportPath = path.join(dir, "report.html");
		fs.writeFileSync(reportPath, Buffer.alloc(MAX_REPORT_BYTES + 1, 0x61));
		globalThis.fetch = vi.fn() as typeof fetch;

		const result = await submitReport(reportPath, "over-limit");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`max ${MAX_REPORT_BYTES}`);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("rejects non-regular report paths before making a gateway request", async () => {
		const dir = temporaryDirectory("bobbit-verification-upload-dir-");
		globalThis.fetch = vi.fn() as typeof fetch;

		const result = await submitReport(dir, "directory");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("regular file");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("inlines a canonical workspace screenshot inside the verifier runtime", async () => {
		const root = temporaryDirectory("bobbit-verification-upload-workspace-");
		process.chdir(root);
		const screenshots = path.join(root, ".bobbit-qa", "screenshots");
		fs.mkdirSync(screenshots, { recursive: true });
		const imagePath = path.join(screenshots, "inside.png");
		const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
		fs.writeFileSync(imagePath, image);
		const reportPath = path.join(root, "report.html");
		fs.writeFileSync(reportPath, `<img src="${pathToFileURL(imagePath).href}" alt="inside">`);
		const capture = captureRequestBody();

		const result = await submitReport(reportPath, "inline-inside");

		expect(result.isError).not.toBe(true);
		expect(capture.body()).not.toHaveProperty("report_html_file");
		expect(capture.body().report_html).toBe(
			`<img src="data:image/png;base64,${image.toString("base64")}" alt="inside">`,
		);
	});

	it("leaves an outside-workspace file URL unchanged and unread", async () => {
		const root = temporaryDirectory("bobbit-verification-upload-root-");
		const outside = temporaryDirectory("bobbit-verification-upload-outside-");
		process.chdir(root);
		const outsideImage = path.join(outside, "outside.png");
		fs.writeFileSync(outsideImage, "outside marker");
		const reportHtml = `<img src="${pathToFileURL(outsideImage).href}" alt="outside">`;
		const reportPath = path.join(root, "report.html");
		fs.writeFileSync(reportPath, reportHtml);
		const openSpy = vi.spyOn(fs, "openSync");
		const capture = captureRequestBody();

		const result = await submitReport(reportPath, "outside");

		expect(result.isError).not.toBe(true);
		expect(capture.body().report_html).toBe(reportHtml);
		expect(
			openSpy.mock.calls.some(([candidate]) => typeof candidate === "string" && path.resolve(candidate) === outsideImage),
		).toBe(false);
	});

	it("does not follow an in-workspace symlink to an outside screenshot", async (context) => {
		const root = temporaryDirectory("bobbit-verification-upload-symlink-root-");
		const outside = temporaryDirectory("bobbit-verification-upload-symlink-outside-");
		process.chdir(root);
		const outsideImage = path.join(outside, "outside.png");
		const linkedImage = path.join(root, "linked.png");
		fs.writeFileSync(outsideImage, "outside symlink marker");
		try {
			fs.symlinkSync(outsideImage, linkedImage, "file");
		} catch {
			context.skip("file symlinks are unavailable on this platform");
			return;
		}
		const reportHtml = `<img src="${pathToFileURL(linkedImage).href}" alt="linked">`;
		const reportPath = path.join(root, "report.html");
		fs.writeFileSync(reportPath, reportHtml);
		const openSpy = vi.spyOn(fs, "openSync");
		const capture = captureRequestBody();

		const result = await submitReport(reportPath, "symlink-escape");

		expect(result.isError).not.toBe(true);
		expect(capture.body().report_html).toBe(reportHtml);
		expect(
			openSpy.mock.calls.some(([candidate]) => typeof candidate === "string" && path.resolve(candidate) === outsideImage),
		).toBe(false);
	});
});

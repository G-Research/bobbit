import { test, expect } from "./in-process-harness.js";
import { agentEndPredicate, apiFetch, connectWs, nonGitCwd } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(__dirname, "..", "fixtures", "claude-code", "fake-claude-cli.mjs");

async function resetClaudeCodePrefs(): Promise<void> {
	await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({
			"claudeCode.executablePath": null,
			"claudeCode.defaultModel": null,
			"claudeCode.permissionMode": null,
			"claudeCode.allowBypassPermissions": null,
		}),
	});
}

function makeFakeWrapper(recordPath: string): { dir: string; executable: string } {
	fs.chmodSync(fakeCli, 0o755);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-claude-code-api-"));
	const executable = path.join(dir, "fake-claude-wrapper.mjs");
	fs.writeFileSync(executable, `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_RECORD_PATH = ${JSON.stringify(recordPath)};\nawait import(${JSON.stringify(fakeCli)});\n`, "utf8");
	fs.chmodSync(executable, 0o755);
	return { dir, executable };
}

function readRecord(recordPath: string): any[] {
	return fs.readFileSync(recordPath, "utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

async function waitForSpawnArgv(recordPath: string): Promise<string[]> {
	await expect.poll(() => fs.existsSync(recordPath) ? readRecord(recordPath)[0]?.argv : undefined).toBeTruthy();
	return readRecord(recordPath)[0].argv;
}

async function waitForSpawnArgvs(recordPath: string, count: number): Promise<string[][]> {
	await expect.poll(() => fs.existsSync(recordPath) ? readRecord(recordPath).filter((entry) => Array.isArray(entry.argv)).length : 0).toBeGreaterThanOrEqual(count);
	return readRecord(recordPath).filter((entry) => Array.isArray(entry.argv)).map((entry) => entry.argv);
}

test.describe("Claude Code runtime session API", () => {
	test.afterEach(async () => {
		await resetClaudeCodePrefs().catch(() => {});
	});

	test("POST /api/sessions honors Claude Code model/runtime and hydrated preferences reach spawn", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-claude-code-create-"));
		const recordPath = path.join(tmp, "record.jsonl");
		const wrapper = makeFakeWrapper(recordPath);
		let sessionId: string | undefined;
		try {
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"claudeCode.executablePath": wrapper.executable,
					"claudeCode.defaultModel": "opus",
					"claudeCode.permissionMode": "acceptEdits",
				}),
			});

			const create = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({
					cwd: nonGitCwd(),
					worktree: false,
					runtime: "claude-code",
					model: { provider: "claude-code", id: "sonnet" },
				}),
			});
			expect(create.status).toBe(201);
			const created = await create.json();
			sessionId = created.id;
			expect(created.runtime).toBe("claude-code");
			expect(created.claudeCodeExecutable).toBe(wrapper.executable);
			expect(created.claudeCodePermissionMode).toBe("acceptEdits");
			expect(created.claudeCodeModelAlias).toBe("sonnet");

			const detail = await (await apiFetch(`/api/sessions/${sessionId}`)).json();
			expect(detail).toMatchObject({
				runtime: "claude-code",
				modelProvider: "claude-code",
				modelId: "sonnet",
				claudeCodeExecutable: wrapper.executable,
				claudeCodePermissionMode: "acceptEdits",
				claudeCodeModelAlias: "sonnet",
			});

			const list = await (await apiFetch("/api/sessions")).json();
			const listed = list.sessions.find((s: any) => s.id === sessionId);
			expect(listed).toMatchObject({ runtime: "claude-code", claudeCodeModelAlias: "sonnet" });

			const argv = await waitForSpawnArgv(recordPath);
			expect(argv).toContain("--permission-mode");
			expect(argv).toContain("acceptEdits");
		} finally {
			if (sessionId) await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(tmp, { recursive: true, force: true });
			fs.rmSync(wrapper.dir, { recursive: true, force: true });
		}
	});

	test("Claude Code default alias and bypass opt-in hydrate into runtime options", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-claude-code-bypass-"));
		const recordPath = path.join(tmp, "record.jsonl");
		const wrapper = makeFakeWrapper(recordPath);
		let sessionId: string | undefined;
		try {
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"claudeCode.executablePath": wrapper.executable,
					"claudeCode.defaultModel": "opus",
					"claudeCode.allowBypassPermissions": true,
					"claudeCode.permissionMode": "bypassPermissions",
				}),
			});
			const create = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, runtime: "claude-code" }),
			});
			expect(create.status).toBe(201);
			const created = await create.json();
			sessionId = created.id;
			expect(created.claudeCodeModelAlias).toBe("opus");
			expect(created.claudeCodePermissionMode).toBe("bypassPermissions");
			const argv = await waitForSpawnArgv(recordPath);
			expect(argv).toContain("--permission-mode");
			expect(argv).toContain("bypassPermissions");
		} finally {
			if (sessionId) await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(tmp, { recursive: true, force: true });
			fs.rmSync(wrapper.dir, { recursive: true, force: true });
		}
	});

	test("Claude Code set_model switches aliases in the same Bobbit session via restart/resume", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-claude-code-setmodel-"));
		const recordPath = path.join(tmp, "record.jsonl");
		const wrapper = makeFakeWrapper(recordPath);
		let sessionId: string | undefined;
		let conn: Awaited<ReturnType<typeof connectWs>> | undefined;
		try {
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({ "claudeCode.executablePath": wrapper.executable }),
			});
			const create = await apiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, model: "claude-code/sonnet" }),
			});
			expect(create.status).toBe(201);
			sessionId = (await create.json()).id;
			conn = await connectWs(sessionId!);
			conn.send({ type: "prompt", text: "capture Claude Code resume id" });
			await conn.waitFor(agentEndPredicate());

			conn.send({ type: "set_model", provider: "claude-code", modelId: "opus" });
			await expect.poll(async () => {
				const detail = await (await apiFetch(`/api/sessions/${sessionId}`)).json();
				return detail.modelProvider === "claude-code" && detail.modelId === "opus" && detail.claudeCodeModelAlias === "opus";
			}).toBe(true);

			const detail = await (await apiFetch(`/api/sessions/${sessionId}`)).json();
			expect(detail.id).toBe(sessionId);
			expect(detail.runtime).toBe("claude-code");
			expect(detail.claudeCodeSessionId).toBe("fake-claude-session");
			expect(detail.modelProvider).toBe("claude-code");
			expect(detail.modelId).toBe("opus");
			expect(detail.claudeCodeModelAlias).toBe("opus");

			const argvs = await waitForSpawnArgvs(recordPath, 2);
			expect(argvs[0]).toContain("--model");
			expect(argvs[0][argvs[0].indexOf("--model") + 1]).toBe("sonnet");
			expect(argvs[1]).toContain("--model");
			expect(argvs[1][argvs[1].indexOf("--model") + 1]).toBe("opus");
			expect(argvs[1]).toContain("--resume");
			expect(argvs[1][argvs[1].indexOf("--resume") + 1]).toBe("fake-claude-session");

			conn.send({ type: "get_state" });
			await conn.waitFor((m: any) => m.type === "state" && m.data?.model?.id === "opus");
			const transcript = await (await apiFetch(`/api/sessions/${sessionId}/transcript?verbose=1`)).json();
			expect(JSON.stringify(transcript)).toContain("capture Claude Code resume id");
			expect(JSON.stringify(transcript)).toContain("Hi there");
		} finally {
			conn?.close();
			if (sessionId) await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(tmp, { recursive: true, force: true });
			fs.rmSync(wrapper.dir, { recursive: true, force: true });
		}
	});

});

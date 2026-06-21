import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, nonGitCwd } from "./e2e-setup.js";
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

	test("unsupported Claude Code set_model failure is not persisted", async () => {
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
			conn.send({ type: "set_model", provider: "claude-code", modelId: "opus" });
			const error = await conn.waitFor((m: any) => m.type === "error" && m.code === "SET_MODEL_FAILED");
			expect(error.message).toContain("requires a new Claude Code session");
			const detail = await (await apiFetch(`/api/sessions/${sessionId}`)).json();
			expect(detail.modelProvider).toBe("claude-code");
			expect(detail.modelId).toBe("sonnet");
			expect(detail.claudeCodeModelAlias).toBe("sonnet");
		} finally {
			conn?.close();
			if (sessionId) await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(tmp, { recursive: true, force: true });
			fs.rmSync(wrapper.dir, { recursive: true, force: true });
		}
	});
});

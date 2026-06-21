/**
 * API E2E — orphan tool-result lifecycle repair.
 *
 * Exercises the real restore/rehydration path that runs before `switch_session`:
 * a persisted transcript containing an aborted assistant tool call plus a late
 * matching toolResult is repaired on disk, restored without wedging the session,
 * and remains clean on a second restore. Also exercises the generated OpenAI
 * Responses guard extension without external credentials by invoking its local
 * before_provider_request hook.
 */
import { test, expect } from "./in-process-harness.js";
import {
	agentEndPredicate,
	connectWs,
	createSession,
	deleteSession,
	statusPredicate,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";
import fs from "node:fs";
import path from "node:path";

interface CapturedConsole {
	logs: string[];
	warns: string[];
}

const ORPHAN_SECRET = "ORPHAN_RESULT_SECRET_SHOULD_NOT_SURVIVE";
const VALID_SECRET = "VALID_RESULT_SHOULD_SURVIVE";
const OPENAI_ORPHAN_GUARD_STATE_SUBDIR = "openai-orphan-tool-result";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

function jsonlLine(entry: unknown): string {
	return JSON.stringify(entry);
}

function craftedTranscript(): string {
	return [
		jsonlLine({ type: "message", id: "user-1", message: { role: "user", content: [{ type: "text", text: "hello before restore" }] } }),
		jsonlLine({
			type: "message",
			id: "aborted-assistant",
			message: {
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "toolCall", id: "late-aborted-call", name: "team_spawn", arguments: { task: "discarded" } }],
			},
		}),
		jsonlLine({
			type: "message",
			id: "orphan-result",
			message: {
				role: "toolResult",
				toolCallId: "late-aborted-call",
				toolName: "team_spawn",
				isError: false,
				content: [{ type: "text", text: ORPHAN_SECRET }],
			},
		}),
		jsonlLine({
			type: "message",
			id: "valid-assistant",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "valid-call", name: "bash", arguments: { command: "echo ok" } }],
			},
		}),
		jsonlLine({
			type: "message",
			id: "valid-result",
			message: {
				role: "toolResult",
				toolCallId: "valid-call",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: VALID_SECRET }],
			},
		}),
	].join("\n") + "\n";
}

function readTranscriptMessages(filePath: string): any[] {
	return fs.readFileSync(filePath, "utf-8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry?.type === "message")
		.map((entry) => entry.message);
}

async function captureConsoleDuring(fn: () => Promise<void>): Promise<CapturedConsole> {
	const originalLog = console.log;
	const originalWarn = console.warn;
	const logs: string[] = [];
	const warns: string[] = [];
	console.log = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
		originalLog(...args);
	};
	console.warn = (...args: unknown[]) => {
		warns.push(args.map(String).join(" "));
		originalWarn(...args);
	};
	try {
		await fn();
	} finally {
		console.log = originalLog;
		console.warn = originalWarn;
	}
	return { logs, warns };
}

async function simulateRestore(gateway: any, sessionId: string): Promise<CapturedConsole> {
	const sm = gateway.sessionManager;
	const liveSession = sm.sessions.get(sessionId);
	if (liveSession) {
		try { liveSession.unsubscribe?.(); } catch { /* best-effort */ }
		try { await liveSession.rpcClient?.stop?.(); } catch { /* already stopped */ }
		sm.sessions.delete(sessionId);
	}
	return captureConsoleDuring(async () => {
		await sm.restoreSessions();
	});
}

async function persistedAgentSessionFile(gateway: any, sessionId: string): Promise<string> {
	const sm = gateway.sessionManager;
	return pollUntil(async () => {
		const file = sm.getPersistedSession(sessionId)?.agentSessionFile;
		return file && fs.existsSync(file) ? file : null;
	}, { timeoutMs: 10_000, intervalMs: 100, label: "agent session file persisted" });
}

function removeOpenAiGuardDir(bobbitDir: string): void {
	fs.rmSync(path.join(bobbitDir, "state", OPENAI_ORPHAN_GUARD_STATE_SUBDIR), { recursive: true, force: true });
}

function openAiGuardExtensionFiles(bobbitDir: string): string[] {
	const root = path.join(bobbitDir, "state", OPENAI_ORPHAN_GUARD_STATE_SUBDIR);
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name === "extension.ts") files.push(full);
		}
	}
	return files;
}

test.describe("orphan tool-result restore lifecycle", () => {
	test("restore repairs persisted orphan tool results, is idempotent, and leaves the session usable", async ({ gateway }) => {
		const sessionId = await createSession();
		let conn: Awaited<ReturnType<typeof connectWs>> | undefined;
		try {
			conn = await connectWs(sessionId);
			conn.send({ type: "prompt", text: "prime orphan lifecycle file" });
			await conn.waitFor(agentEndPredicate(), 15_000);
			await conn.waitFor(statusPredicate("idle"), 10_000).catch(() => {});
			conn.close();
			conn = undefined;

			const agentSessionFile = await persistedAgentSessionFile(gateway, sessionId);
			expect(agentSessionFile, "test must use a real agent sessions transcript path").toContain(`${path.sep}agent${path.sep}sessions${path.sep}`);

			fs.writeFileSync(agentSessionFile, craftedTranscript(), "utf-8");
			expect(fs.readFileSync(agentSessionFile, "utf-8")).toContain(ORPHAN_SECRET);

			const { resetOpenAiOrphanToolResultExtensionCache } = await import("../../dist/server/agent/openai-orphan-tool-result-extension.js");
			resetOpenAiOrphanToolResultExtensionCache();
			removeOpenAiGuardDir(gateway.bobbitDir);

			const firstRestore = await simulateRestore(gateway, sessionId);
			const repaired = fs.readFileSync(agentSessionFile, "utf-8");
			expect(repaired).not.toContain(ORPHAN_SECRET);
			expect(repaired).toContain(VALID_SECRET);
			expect(readTranscriptMessages(agentSessionFile).filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual(["valid-call"]);

			const repairLog = [...firstRestore.logs, ...firstRestore.warns].join("\n");
			expect(repairLog).toContain("[transcript-sanitizer]");
			expect(repairLog).toContain("dropped 1 orphan tool result row(s)");
			expect(repairLog).not.toContain(ORPHAN_SECRET);
			expect(openAiGuardExtensionFiles(gateway.bobbitDir).length, "restore setup should install the OpenAI orphan guard extension").toBeGreaterThan(0);

			const beforeSecondRestore = fs.readFileSync(agentSessionFile, "utf-8");
			const secondRestore = await simulateRestore(gateway, sessionId);
			expect(fs.readFileSync(agentSessionFile, "utf-8"), "second restore must be idempotent").toBe(beforeSecondRestore);
			expect([...secondRestore.logs, ...secondRestore.warns].join("\n")).not.toContain("orphan tool result");

			conn = await connectWs(sessionId);
			conn.send({ type: "prompt", text: "orphan lifecycle follow-up" });
			await conn.waitFor(agentEndPredicate(), 15_000);
			await conn.waitFor(statusPredicate("idle"), 10_000).catch(() => {});
		} finally {
			conn?.close();
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("generated OpenAI Responses guard hook drops only orphan function_call_output items", async ({ gateway }) => {
		const { resetOpenAiOrphanToolResultExtensionCache, writeOpenAiOrphanToolResultExtension } = await import("../../dist/server/agent/openai-orphan-tool-result-extension.js");
		resetOpenAiOrphanToolResultExtensionCache();
		removeOpenAiGuardDir(gateway.bobbitDir);

		const extensionPath = writeOpenAiOrphanToolResultExtension();
		expect(extensionPath).toBeTruthy();
		expect(extensionPath).toContain(path.join(gateway.bobbitDir, "state", OPENAI_ORPHAN_GUARD_STATE_SUBDIR));
		expect(extensionPath).not.toContain(path.join(gateway.bobbitDir, "state", "tool-guard"));

		const source = fs.readFileSync(extensionPath!, "utf-8");
		const install = new Function(source.replace("export default function(pi)", "return function(pi)")) as () => (pi: { on: (event: string, cb: (event: any) => unknown) => void }) => void;
		let beforeProviderRequest: ((event: any) => unknown) | undefined;
		install()({
			on(event, cb) {
				if (event === "before_provider_request") beforeProviderRequest = cb;
			},
		});
		expect(beforeProviderRequest).toBeTruthy();

		const payload = {
			model: "gpt-test",
			input: [
				{ type: "function_call_output", call_id: "missing", output: "RAW_ORPHAN_OUTPUT" },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ type: "function_call", call_id: "valid", name: "bash", arguments: "{}" },
				{ type: "function_call_output", call_id: "valid", output: "VALID_OUTPUT" },
			],
		};

		const captured = await captureConsoleDuring(async () => {
			const next = beforeProviderRequest!({ payload });
			expect(next).toEqual({
				...payload,
				input: payload.input.slice(1),
			});
		});
		const guardLog = [...captured.logs, ...captured.warns].join("\n");
		expect(guardLog).toContain("[bobbit-openai-orphan-guard] Dropped 1 orphan function_call_output item(s)");
		expect(guardLog).not.toContain("RAW_ORPHAN_OUTPUT");
	});
});

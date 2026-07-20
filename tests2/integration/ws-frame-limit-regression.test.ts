import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { expect } from "./_e2e/in-process-harness.js";
import { test } from "./_e2e/in-process-harness.js";
import {
	connectWs,
	createSession,
	defaultProjectId,
	deleteSession,
	harnessDefaultProjectRoot,
	messageEndPredicate,
} from "./_e2e/e2e-setup.js";
import { mintSurfaceToken } from "../../src/server/extension-host/surface-binding.ts";
import {
	computeContentHash,
	mintWritePermit,
} from "../../src/server/extension-host/session-write-permit.ts";

const EXTENSION_CHANNEL_ENVELOPE_CAP_BYTES = 1024 * 1024;
const EXPECTED_AUTHENTICATED_PROMPT_TEXT_CAP_BYTES = 8 * 1024 * 1024;
const EXPECTED_FILE_MENTION_CANDIDATE_LIMIT = 8_192;
const handlerModule = await import("../../src/server/ws/handler.ts");
const resolverModule = await import("../../src/server/skills/resolve-file-mentions.ts");
const slashSkillsModule = await import("../../src/server/skills/slash-skills.ts");
const MAX_AUTHENTICATED_PROMPT_TEXT_BYTES = Reflect.get(
	handlerModule,
	"MAX_AUTHENTICATED_PROMPT_TEXT_BYTES",
) as number;
const MAX_FILE_MENTION_RAW_CANDIDATES = Reflect.get(
	resolverModule,
	"MAX_FILE_MENTION_RAW_CANDIDATES",
) as number;

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((onResolve) => {
		resolve = onResolve;
	});
	return { promise, resolve };
}

async function waitForSignal<T>(signal: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			signal,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function validDefaultResumeExtensionPost(sessionId: string, requestId: string, text: string) {
	const surfaceToken = mintSurfaceToken({
		sessionId,
		packId: "terminal",
		contributionId: "panel:terminal.panel",
	});
	const nonce = mintWritePermit({
		sessionId,
		packId: "terminal",
		tool: "",
		contentHash: computeContentHash("user", text),
	});
	return {
		type: "ext_session_post",
		requestId,
		surfaceToken,
		role: "user",
		text,
		nonce,
	};
}

const STRUCTURALLY_INVALID_JSON_FRAMES: ReadonlyArray<{ label: string; value: unknown }> = [
	{ label: "null", value: null },
	{ label: "array", value: [] },
	{ label: "scalar", value: 42 },
];

test.describe("WebSocket frame size routing", () => {
	test("allows authenticated non-extension prompt frames over the extension-channel envelope cap", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				const promptText = "x".repeat(EXTENSION_CHANNEL_ENVELOPE_CAP_BYTES + 1);
				const cursor = conn.messageCount();
				conn.send({ type: "prompt", text: promptText });

				const outcome = await conn.waitForFrom(
					cursor,
					(m) => m.type === "error" || messageEndPredicate("user")(m),
					10_000,
				);

				expect(
					messageEndPredicate("user")(outcome),
					`Non-extension prompt frames larger than 1 MiB must not be rejected by the extension-channel envelope guard; received ${JSON.stringify(outcome)}. FRAME_TOO_LARGE means the regression is present.`,
				).toBe(true);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("rejects authenticated prompt text above its generic cap with a structured error and keeps the socket usable", async () => {
		expect(MAX_AUTHENTICATED_PROMPT_TEXT_BYTES).toBe(EXPECTED_AUTHENTICATED_PROMPT_TEXT_CAP_BYTES);
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				const promptText = "x".repeat(EXPECTED_AUTHENTICATED_PROMPT_TEXT_CAP_BYTES + 1);
				const cursor = conn.messageCount();
				conn.send({ type: "prompt", text: promptText });

				const outcome = await conn.waitForFrom(
					cursor,
					(m) => m.type === "error" || messageEndPredicate("user")(m),
					10_000,
				);

				expect(outcome.type).toBe("error");
				expect(outcome.code).toBe("PROMPT_TOO_LARGE");
				expect(outcome.message ?? "").toMatch(/prompt text.*maximum size|too large|size/i);

				const pingCursor = conn.messageCount();
				conn.send({ type: "ping" });
				await conn.waitForFrom(pingCursor, (m) => m.type === "pong", 5_000);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});

	for (const invalidFrame of STRUCTURALLY_INVALID_JSON_FRAMES) {
		test(`rejects an authenticated ${invalidFrame.label} JSON frame without closing the socket`, async () => {
			const sessionId = await createSession();
			try {
				const conn = await connectWs(sessionId);
				try {
					const cursor = conn.messageCount();
					conn.ws.send(JSON.stringify(invalidFrame.value));

					const outcome = await conn.waitForFrom(cursor, (m) => m.type === "error", 1_000);
					expect(outcome).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
					expect(outcome.message ?? "").toMatch(/invalid.*message|message.*object/i);

					const pingCursor = conn.messageCount();
					conn.send({ type: "ping" });
					await conn.waitForFrom(pingCursor, (m) => m.type === "pong", 5_000);
				} finally {
					conn.close();
				}
			} finally {
				await deleteSession(sessionId);
			}
		});
	}

	test("rejects candidate overflow before slash-skill discovery, filesystem probing, or enqueue", async ({ gateway }) => {
		expect(MAX_FILE_MENTION_RAW_CANDIDATES).toBe(EXPECTED_FILE_MENTION_CANDIDATE_LIMIT);
		const skillName = `admission-preflight-${process.pid}-${Date.now()}`;
		const fixtureCwd = path.join(
			harnessDefaultProjectRoot(),
			".e2e-workspaces",
			`ws-admission-preflight-${process.pid}-${Date.now()}`,
		);
		const skillDir = path.join(fixtureCwd, ".claude", "skills", skillName);
		const skillFile = path.join(skillDir, "SKILL.md");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(skillFile, "---\ndescription: admission preflight probe\n---\nSHOULD_NOT_BE_DISCOVERED\n");

		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const sessionId = await createSession({ cwd: fixtureCwd, projectId: projectId! });
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live, "created admission-preflight session must be live").toBeTruthy();
		const mentionPath = path.resolve(live.worktreePath || live.cwd, "admission-overflow.txt");
		const conn = await connectWs(sessionId);
		await conn.waitFor((m) => m.type === "queue_update");
		slashSkillsModule.invalidateSlashSkillsCache();

		const existsSpy = vi.spyOn(fs, "existsSync");
		const readFileSpy = vi.spyOn(fs, "readFileSync");
		const lstatSpy = vi.spyOn(fs.promises, "lstat");
		const enqueueSpy = vi.spyOn(gateway.sessionManager, "enqueuePrompt");

		try {
			const candidates = Array.from(
				{ length: MAX_FILE_MENTION_RAW_CANDIDATES + 1 },
				() => "@admission-overflow.txt",
			).join(" ");
			const promptText = `/${skillName} ${candidates}`;
			expect(Buffer.byteLength(promptText, "utf8")).toBeLessThan(MAX_AUTHENTICATED_PROMPT_TEXT_BYTES);

			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: promptText });
			const outcome = await conn.waitForFrom(
				cursor,
				(m) => m.type === "error" || messageEndPredicate("user")(m),
				5_000,
			);

			expect(outcome).toMatchObject({ type: "error", code: "FILE_MENTION_CANDIDATE_LIMIT" });
			expect(outcome.message ?? "").toMatch(/8192.*non-code file-mention candidates/i);
			expect(
				existsSpy.mock.calls.filter(([target]) => path.resolve(String(target)).startsWith(path.resolve(skillDir))).length,
				"whole-send admission must run before slash-skill discovery touches its fixture",
			).toBe(0);
			expect(
				readFileSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(skillFile)).length,
				"whole-send admission must run before reading a matching SKILL.md",
			).toBe(0);
			expect(
				lstatSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === mentionPath).length,
				"candidate overflow must reject before file-mention lstat probing",
			).toBe(0);
			expect(
				enqueueSpy.mock.calls.filter(([id]) => id === sessionId).length,
				"an inadmissible prompt must never be partially enqueued",
			).toBe(0);
		} finally {
			enqueueSpy.mockRestore();
			lstatSpy.mockRestore();
			readFileSpy.mockRestore();
			existsSpy.mockRestore();
			conn.close();
			await deleteSession(sessionId);
			fs.rmSync(fixtureCwd, { recursive: true, force: true });
		}
	});

	test("does not let a valid default-resume extension post overtake earlier mention preprocessing", async ({ gateway }) => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live, "created ordering session must be live").toBeTruthy();
		await conn.waitFor((m) => m.type === "queue_update");

		const mentionName = `ws-ordered-mention-${sessionId}.txt`;
		const mentionPath = path.resolve(live.worktreePath || live.cwd, mentionName);
		fs.rmSync(mentionPath, { force: true });
		const promptText = `EARLIER_PROMPT @${mentionName}`;
		const extensionText = "DEFAULT_RESUME_EXTENSION";
		const requestId = `ordered-extension-${sessionId}`;
		const probeStarted = deferred<void>();
		const releaseProbe = deferred<void>();
		const promptEnqueued = deferred<void>();
		const extensionEnqueued = deferred<void>();
		const enqueuedTexts: string[] = [];
		let probeReleased = false;
		const releasePendingProbe = () => {
			if (probeReleased) return;
			probeReleased = true;
			releaseProbe.resolve();
		};

		const originalLstat = fs.promises.lstat.bind(fs.promises);
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(((target: fs.PathLike) => {
			if (path.resolve(String(target)) !== mentionPath) return originalLstat(target);
			probeStarted.resolve();
			return releaseProbe.promise.then(() => {
				throw Object.assign(new Error("missing deterministic ordering fixture"), { code: "ENOENT" });
			});
		}) as typeof fs.promises.lstat);
		const originalEnqueue = gateway.sessionManager.enqueuePrompt.bind(gateway.sessionManager);
		const enqueueSpy = vi.spyOn(gateway.sessionManager, "enqueuePrompt").mockImplementation(async (
			id,
			text,
			opts,
		) => {
			if (typeof text !== "string") throw new TypeError("enqueuePrompt text must be a string");
			if (id !== sessionId) return originalEnqueue(id, text, opts);
			enqueuedTexts.push(text);
			if (text === promptText) promptEnqueued.resolve();
			if (text === extensionText) extensionEnqueued.resolve();
			return { status: "queued" };
		});

		try {
			conn.send({ type: "prompt", text: promptText });
			await waitForSignal(probeStarted.promise, "earlier prompt mention preprocessing");

			conn.send(validDefaultResumeExtensionPost(sessionId, requestId, extensionText));
			const pingCursor = conn.messageCount();
			conn.send({ type: "ping" });
			await conn.waitForFrom(pingCursor, (m) => m.type === "pong", 1_000);

			expect(
				[...enqueuedTexts],
				"the extension default-resume must remain behind the earlier prompt while its mention probe is pending",
			).toEqual([]);

			releasePendingProbe();
			await waitForSignal(extensionEnqueued.promise, "ordered extension enqueue");
			const result = await conn.waitFor(
				(m) => m.type === "ext_session_post_result" && m.requestId === requestId,
				1_000,
			);
			expect(result).toMatchObject({ type: "ext_session_post_result", requestId, ok: true });
			expect(enqueuedTexts).toEqual([promptText, extensionText]);
		} finally {
			releasePendingProbe();
			await waitForSignal(promptEnqueued.promise, "earlier prompt cleanup", 1_000).catch(() => {});
			await conn.waitFor(
				(m) => m.type === "ext_session_post_result" && m.requestId === requestId,
				1_000,
			).catch(() => {});
			enqueueSpy.mockRestore();
			lstatSpy.mockRestore();
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("dispatches abort during mention preprocessing and cancels only the delayed prompt", async ({ gateway }) => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live, "created abort-ordering session must be live").toBeTruthy();
		await conn.waitFor((m) => m.type === "queue_update");

		const previousStatus = live.status;
		live.status = "streaming";
		const mentionName = `ws-aborted-mention-${sessionId}.txt`;
		const mentionPath = path.resolve(live.worktreePath || live.cwd, mentionName);
		fs.rmSync(mentionPath, { force: true });
		const delayedPrompt = `ABORTED_PROMPT @${mentionName}`;
		const laterPrompts = ["LATER_PROMPT_ONE", "LATER_PROMPT_TWO"];
		const probeStarted = deferred<void>();
		const releaseProbe = deferred<void>();
		const abortDispatched = deferred<void>();
		const laterQueueDrained = deferred<void>();
		const enqueuedTexts: string[] = [];
		let probeReleased = false;
		const releasePendingProbe = () => {
			if (probeReleased) return;
			probeReleased = true;
			releaseProbe.resolve();
		};

		const originalLstat = fs.promises.lstat.bind(fs.promises);
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(((target: fs.PathLike) => {
			if (path.resolve(String(target)) !== mentionPath) return originalLstat(target);
			probeStarted.resolve();
			return releaseProbe.promise.then(() => {
				throw Object.assign(new Error("missing deterministic abort fixture"), { code: "ENOENT" });
			});
		}) as typeof fs.promises.lstat);
		const originalEnqueue = gateway.sessionManager.enqueuePrompt.bind(gateway.sessionManager);
		const enqueueSpy = vi.spyOn(gateway.sessionManager, "enqueuePrompt").mockImplementation(async (
			id,
			text,
			opts,
		) => {
			if (typeof text !== "string") throw new TypeError("enqueuePrompt text must be a string");
			if (id !== sessionId) return originalEnqueue(id, text, opts);
			enqueuedTexts.push(text);
			if (text === laterPrompts[1]) laterQueueDrained.resolve();
			return { status: "queued" };
		});
		const originalForceAbort = gateway.sessionManager.forceAbort.bind(gateway.sessionManager);
		const abortSpy = vi.spyOn(gateway.sessionManager, "forceAbort").mockImplementation(async (id, gracePeriodMs) => {
			if (id !== sessionId) return originalForceAbort(id, gracePeriodMs);
			abortDispatched.resolve();
		});

		try {
			conn.send({ type: "prompt", text: delayedPrompt });
			await waitForSignal(probeStarted.promise, "abort target mention preprocessing");

			conn.send({ type: "abort" });
			await waitForSignal(abortDispatched.promise, "abort dispatch while preprocessing remains blocked");
			expect(probeReleased).toBe(false);

			for (const text of laterPrompts) conn.send({ type: "prompt", text });
			const pingCursor = conn.messageCount();
			conn.send({ type: "ping" });
			await conn.waitForFrom(pingCursor, (m) => m.type === "pong", 1_000);
			expect(enqueuedTexts).toEqual([]);

			releasePendingProbe();
			await waitForSignal(laterQueueDrained.promise, "post-abort FIFO drain");
			expect(
				enqueuedTexts,
				"abort must discard the in-flight preprocessed prompt without dropping or reordering later commands",
			).toEqual(laterPrompts);
		} finally {
			releasePendingProbe();
			await waitForSignal(laterQueueDrained.promise, "post-abort cleanup", 1_000).catch(() => {});
			abortSpy.mockRestore();
			enqueueSpy.mockRestore();
			lstatSpy.mockRestore();
			live.status = previousStatus;
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("dispatches live steer before pending asynchronous prompt mention preprocessing completes", async ({ gateway }) => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);
		const live = gateway.sessionManager.getSession(sessionId);
		expect(live, "created session must be live").toBeTruthy();
		await conn.waitFor((m) => m.type === "queue_update");

		const previousStatus = live.status;
		live.status = "streaming";
		const mentionName = `ws-pending-mention-${sessionId}.txt`;
		const mentionPath = path.resolve(live.worktreePath || live.cwd, mentionName);
		fs.rmSync(mentionPath, { force: true });

		let signalProbeStarted!: () => void;
		const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve; });
		let releaseProbe!: () => void;
		const probeRelease = new Promise<void>((resolve) => { releaseProbe = resolve; });
		let signalSteerDispatched!: () => void;
		const steerDispatched = new Promise<void>((resolve) => { signalSteerDispatched = resolve; });
		let probeReleased = false;
		const releasePendingProbe = () => {
			if (probeReleased) return;
			probeReleased = true;
			releaseProbe();
		};

		const originalLstat = fs.promises.lstat.bind(fs.promises);
		const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(((target: fs.PathLike) => {
			if (path.resolve(String(target)) !== mentionPath) return originalLstat(target);
			signalProbeStarted();
			return probeRelease.then(() => {
				throw Object.assign(new Error("missing deterministic WS fixture"), { code: "ENOENT" });
			});
		}) as typeof fs.promises.lstat);
		const steerSpy = vi.spyOn(gateway.sessionManager, "deliverLiveSteer").mockImplementation((async (
			id: string,
			text: string,
		) => {
			if (id === sessionId && text === "LIVE_STEER") signalSteerDispatched();
			return { success: true };
		}) as typeof gateway.sessionManager.deliverLiveSteer);

		try {
			const promptText = `pending @${mentionName}`;
			const promptCursor = conn.messageCount();
			conn.send({ type: "prompt", text: promptText });
			await waitForSignal(probeStarted, "prompt mention lstat barrier");

			conn.send({ type: "steer", text: "LIVE_STEER" });
			await waitForSignal(
				steerDispatched,
				"live steer dispatch while prompt mention preprocessing is still pending",
			);
			expect(steerSpy).toHaveBeenCalledWith(sessionId, "LIVE_STEER");
			expect(probeReleased).toBe(false);

			releasePendingProbe();
			const queued = await conn.waitForFrom(
				promptCursor,
				(m) => m.type === "queue_update" && m.queue?.some((row: { text?: string }) => row.text === promptText),
				5_000,
			);
			expect(queued.queue.some((row: { text?: string }) => row.text === promptText)).toBe(true);
		} finally {
			releasePendingProbe();
			steerSpy.mockRestore();
			lstatSpy.mockRestore();
			live.status = previousStatus;
			conn.close();
			await deleteSession(sessionId);
		}
	});

	test("rejects oversized extension-channel frames with a structured result and keeps the socket usable", async () => {
		const sessionId = await createSession();
		try {
			const conn = await connectWs(sessionId);
			try {
				const requestId = "oversized-ext-channel-send";
				const oversizedFrameText = "x".repeat(EXTENSION_CHANNEL_ENVELOPE_CAP_BYTES + 1);
				const cursor = conn.messageCount();
				conn.send({
					type: "ext_channel_send",
					requestId,
					channelId: "channel-not-attached",
					frame: { kind: "text", data: oversizedFrameText },
				});

				const result = await conn.waitForFrom(
					cursor,
					(m) =>
						(m.type === "ext_channel_result" && m.requestId === requestId) ||
						m.type === "error",
					10_000,
				);

				const structuredFrameTooLargeError =
					(result.type === "error" &&
						result.code === "FRAME_TOO_LARGE" &&
						/WebSocket frame exceeds maximum envelope size|too large|size/i.test(result.message ?? "")) ||
					(result.type === "ext_channel_result" &&
						result.requestId === requestId &&
						result.ok === false &&
						/FRAME_TOO_LARGE|maximum envelope|too large|size/i.test(`${result.error ?? ""} ${result.message ?? ""}`));

				expect(
					structuredFrameTooLargeError,
					`Oversized extension-channel frames must reject with a structured size error instead of closing/crashing; received ${JSON.stringify(result)}`,
				).toBe(true);

				const pingCursor = conn.messageCount();
				conn.send({ type: "ping" });
				await conn.waitForFrom(pingCursor, (m) => m.type === "pong", 5_000);
			} finally {
				conn.close();
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});

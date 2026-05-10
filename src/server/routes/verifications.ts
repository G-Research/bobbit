/**
 * Verification + ask-user-choices submit internal endpoints.
 * Extracted from server.ts (commit: split server.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { inlineFileImages } from "../agent/inline-file-images.js";
import { validateAnswers, crossValidate, type UserQuestion } from "../agent/ask-user-choices-validation.js";
import { buildAskResponseEnvelope, findAskResponseAnswers } from "../../shared/ask-envelope.js";
import type { Route } from "./types.js";

// In-memory dedup guard for ask_user_choices /submit. Keyed by
// `${sessionId}::${toolUseId}`. Populated synchronously before enqueuing the
// response envelope so a concurrent duplicate /submit returns alreadySubmitted
// even when the transcript hasn't yet reflected the first envelope.
// Entries are also refilled from the transcript check, so survive process
// restarts via the transcript fallback in findAskResponseAnswers.
const askSubmittedToolUseIds = new Set<string>();

export const verificationsRoutes: Route[] = [
	{
		method: "POST",
		pattern: "/api/internal/verification-result",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			if (!body?.sessionId || !body?.verdict || !body?.summary || typeof body.sessionId !== "string" || typeof body.verdict !== "string" || typeof body.summary !== "string") {
				json({ error: "Missing required fields: sessionId, verdict, summary" }, 400);
				return;
			}
			const resolver = deps.verificationHarness.pendingResults.get(body.sessionId);
			if (!resolver) {
				json({ error: "No pending verification for this session" }, 404);
				return;
			}
			if (typeof body.report_html === "string" && typeof body.report_html_file === "string") {
				json({ error: "Provide either report_html or report_html_file, not both" }, 400);
				return;
			}
			let reportHtml: string | undefined = typeof body.report_html === "string" ? body.report_html : undefined;
			if (!reportHtml && typeof body.report_html_file === "string") {
				try {
					let filePath = body.report_html_file;
					if (!path.isAbsolute(filePath)) {
						const session = deps.sessionManager.getSession(body.sessionId);
						if (session) filePath = path.resolve(session.cwd, filePath);
					}
					if (process.platform === "win32" && !fs.existsSync(filePath) && body.report_html_file.startsWith("/tmp/")) {
						const tempDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
						const tempResolved = path.join(tempDir, body.report_html_file.slice(5));
						if (fs.existsSync(tempResolved)) filePath = tempResolved;
					}
					const stat = fs.statSync(filePath);
					const MAX_REPORT_SIZE = 10 * 1024 * 1024; // 10 MB
					if (stat.size > MAX_REPORT_SIZE) {
						json({ error: `Report file too large (${stat.size} bytes, max ${MAX_REPORT_SIZE})` }, 400);
						return;
					}
					reportHtml = fs.readFileSync(filePath, "utf-8");
				} catch (e: any) {
					json({ error: `Failed to read report file: ${e.message}` }, 400);
					return;
				}
			}
			if (reportHtml) {
				const session = deps.sessionManager.getSession(body.sessionId);
				if (session?.cwd) {
					try {
						reportHtml = inlineFileImages(reportHtml, session.cwd, {
							logger: (msg) => console.warn(msg),
						});
					} catch (err: any) {
						console.warn(`[verification] inlineFileImages failed: ${err?.message || err}`);
					}
				}
			}
			resolver({
				verdict: body.verdict === "pass",
				summary: body.summary,
				reportHtml,
			});
			json({ ok: true });
		},
	},
	{
		method: "POST",
		pattern: "/api/internal/user-question/submit",
		handler: async ({ deps, readBody, json }) => {
			const body = await readBody();
			const { sessionId, toolUseId, answers } = body || {};
			if (typeof sessionId !== "string" || typeof toolUseId !== "string" || !Array.isArray(answers)) {
				json({ error: "Missing required fields: sessionId, toolUseId, answers" }, 400);
				return;
			}
			const answerErr = validateAnswers(answers);
			if (answerErr) { json({ error: answerErr }, 400); return; }
			const session = deps.sessionManager.getSession(sessionId);
			if (!session) { json({ error: "Unknown session" }, 404); return; }

			let messages: any[] = [];
			try {
				const msgsResp = await session.rpcClient.getMessages();
				const raw = msgsResp?.data?.messages || msgsResp?.data;
				if (Array.isArray(raw)) messages = raw;
			} catch (e: any) {
				json({ error: `Could not load transcript: ${e?.message || String(e)}` }, 500);
				return;
			}

			const dedupKey = `${sessionId}::${toolUseId}`;
			if (askSubmittedToolUseIds.has(dedupKey)) {
				json({ ok: true, alreadySubmitted: true });
				return;
			}
			const existing = findAskResponseAnswers(messages, toolUseId);
			if (existing) {
				askSubmittedToolUseIds.add(dedupKey);
				json({ ok: true, alreadySubmitted: true });
				return;
			}

			let matchedQuestions: UserQuestion[] | null = null;
			for (const m of messages) {
				if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
				for (const b of m.content) {
					if (!b) continue;
					const isToolUse = b.type === "toolCall" || b.type === "tool_use";
					if (!isToolUse) continue;
					if (b.name !== "ask_user_choices") continue;
					if (b.id !== toolUseId) continue;
					const args = b.arguments ?? b.input;
					if (args && Array.isArray(args.questions)) {
						matchedQuestions = args.questions as UserQuestion[];
					}
					break;
				}
				if (matchedQuestions) break;
			}
			if (!matchedQuestions) {
				json({ error: "No matching ask_user_choices tool call in transcript" }, 404);
				return;
			}
			const crossErr = crossValidate(matchedQuestions, answers);
			if (crossErr) { json({ error: crossErr }, 400); return; }

			const envelope = buildAskResponseEnvelope(toolUseId, answers);
			askSubmittedToolUseIds.add(dedupKey);
			try {
				await deps.sessionManager.enqueuePrompt(sessionId, envelope);
			} catch (e: any) {
				askSubmittedToolUseIds.delete(dedupKey);
				json({ error: `Failed to enqueue response: ${e?.message || String(e)}` }, 500);
				return;
			}
			json({ ok: true });
		},
	},
];

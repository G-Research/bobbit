/**
 * Ask tool extension for Bobbit.
 *
 * Registers `ask_user_choices` — asks the user 1–5 multiple-choice questions via
 * an interactive inline widget. Blocks until the user submits.
 *
 * Mirrors the `verification_result` round-trip pattern (see tasks/extension.ts).
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
	const sessionId = process.env.BOBBIT_SESSION_ID;
	if (!sessionId) return;

	let token: string;
	let baseUrl: string;
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		token = envToken;
		baseUrl = envUrl.replace(/\/+$/, "");
	} else {
		try {
			const stateDir = process.env.BOBBIT_DIR
				? path.join(process.env.BOBBIT_DIR, "state")
				: path.join(homedir(), ".pi");
			const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
			const urlFile = process.env.BOBBIT_DIR ? "gateway-url" : "gateway-url";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[ask-tools] Cannot read gateway credentials — tool not registered");
			return;
		}
	}

	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const resp = await fetch(`${baseUrl}${urlPath}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let data: unknown;
		try { data = JSON.parse(text); } catch { data = text; }
		if (!resp.ok) {
			const msg = typeof data === "object" && data !== null && "error" in data
				? String((data as Record<string, unknown>).error)
				: `HTTP ${resp.status}: ${text}`;
			throw new Error(msg);
		}
		return data;
	}

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
	}
	function err(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	pi.registerTool({
		name: "ask_user_choices",
		label: "Ask User Choices",
		description: [
			"Ask the user 1–5 multiple-choice questions via an inline interactive widget.",
			"Blocks until the user submits their answers.",
			"Returns { answers: [{ question, selected, other_text }] }.",
		].join(" "),
		promptSnippet: "Ask the user multiple-choice questions and wait for answers.",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ minLength: 1, description: "The question prompt" }),
					options: Type.Array(Type.String({ minLength: 1 }), {
						minItems: 2,
						maxItems: 8,
						description: "2–8 answer options",
					}),
					allow_other: Type.Optional(Type.Boolean({
						description: "If true, render an 'Other' option with a free-text input",
					})),
					multi: Type.Optional(Type.Boolean({
						description: "If true, user may select multiple options; selected is returned as a string[].",
					})),
					min: Type.Optional(Type.Integer({
						minimum: 1,
						description: "Minimum selections when multi:true (default 1).",
					})),
					max: Type.Optional(Type.Integer({
						minimum: 1,
						description: "Maximum selections when multi:true (default = options.length).",
					})),
				}),
				{ minItems: 1, maxItems: 5, description: "1–5 multiple-choice questions" },
			),
		}),
		async execute(toolUseId, params) {
			try {
				const body = { sessionId, toolUseId, questions: params.questions };
				const resp = await api("POST", "/api/internal/user-question", body);
				return ok(resp);
			} catch (e: any) {
				return err(e.message);
			}
		},
	});

	console.log(`[ask-tools] Registered ask_user_choices for session ${sessionId}`);
}

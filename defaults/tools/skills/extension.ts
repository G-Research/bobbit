/**
 * Skills tool extension for Bobbit.
 *
 * Registers the `activate_skill` tool which lets the model autonomously
 * invoke a slash skill mid-turn. Implementation calls back into the gateway
 * via `POST /api/sessions/:id/activate-skill`, which runs the same
 * `buildSlashSkillPrompt` path that user invocations use, so the agent's
 * view of the result is identical to a user-typed `/<name> <args>`.
 *
 * Loaded automatically via --extension when the session has `activate_skill`
 * in its allowedTools list (or no restrictions).
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
			const urlFile = "gateway-url";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[skills-tools] Cannot read gateway credentials — activate_skill tool not registered");
			return;
		}
	}

	pi.registerTool({
		name: "activate_skill",
		label: "Activate Skill",
		description: "Activate a discovered skill by name. Returns the skill's instructions as the tool result; follow them as if the user had typed /<name> <args>.",
		promptSnippet: "Activate a discovered slash skill autonomously.",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name (without leading slash)" }),
			args: Type.Optional(Type.String({ description: "Optional argument string passed to the skill" })),
		}),
		async execute(input: { name: string; args?: string }) {
			try {
				const resp = await fetch(`${baseUrl}/api/sessions/${sessionId}/activate-skill`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ name: input.name, args: input.args ?? "" }),
				});
				const text = await resp.text();
				let data: any;
				try { data = JSON.parse(text); } catch { data = { error: text }; }
				if (!resp.ok) {
					const msg = data?.error || `HTTP ${resp.status}`;
					return {
						content: [{ type: "text" as const, text: `activate_skill failed: ${msg}` }],
						details: undefined,
						isError: true,
					};
				}
				const expanded: string = data.expanded ?? "";
				return {
					content: [{ type: "text" as const, text: expanded }],
					details: {
						skillExpansion: {
							name: input.name,
							args: input.args ?? "",
							source: data.source,
							filePath: data.filePath,
							expanded,
						},
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `activate_skill error: ${err?.message ?? err}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});
}

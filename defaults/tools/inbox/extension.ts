/**
 * Staff inbox tool extension for Bobbit.
 *
 * Registers `inbox_list`, `inbox_complete`, and `inbox_dismiss` for any session
 * that belongs to a staff agent (i.e. `BOBBIT_STAFF_ID` is set in the env).
 *
 * Non-staff sessions never have `BOBBIT_STAFF_ID`, so this extension is a no-op
 * there and the tools are not exposed in the tool catalogue. That is the
 * intended gating mechanism — mirrors `defaults/tools/tasks/extension.ts` which
 * uses `BOBBIT_GOAL_ID` the same way.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const staffId = process.env.BOBBIT_STAFF_ID;
	if (!sessionId || !staffId) {
		return;
	}

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
			console.error("[inbox-tools] Cannot read gateway credentials — tools not registered");
			return;
		}
	}

	// ── HTTP helper ───────────────────────────────────────────────────
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

	// ── Inbox tools ───────────────────────────────────────────────────

	pi.registerTool({
		name: "inbox_list",
		label: "List Inbox",
		description: "List inbox entries for this staff agent. Defaults to pending entries.",
		promptSnippet: "List inbox entries for this staff agent.",
		parameters: Type.Object({
			state: Type.Optional(Type.Union([
				Type.Literal("pending"),
				Type.Literal("completed"),
				Type.Literal("failed"),
				Type.Literal("cancelled"),
			], { description: "Filter by state. Defaults to pending." })),
			limit: Type.Optional(Type.Number({ description: "Max entries to return. Default 50." })),
		}),
		async execute(_id, params) {
			try {
				const qs = new URLSearchParams();
				qs.set("state", params.state ?? "pending");
				// Apply the documented default (50) when the agent omits limit, so a
				// busy staff inbox cannot dump unbounded entries into context.
				qs.set("limit", String(params.limit ?? 50));
				return ok(await api("GET", `/api/staff/${staffId}/inbox?${qs}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "inbox_complete",
		label: "Complete Inbox Entry",
		description: "Mark an inbox entry as completed with an optional result summary.",
		promptSnippet: "Mark an inbox entry as completed with an optional summary.",
		parameters: Type.Object({
			entry_id: Type.String({ description: "Inbox entry id from inbox_list." }),
			summary: Type.Optional(Type.String({ description: "Result summary stored on the entry." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { sessionId };
				if (params.summary !== undefined) body.summary = params.summary;
				return ok(await api("POST", `/api/staff/${staffId}/inbox/${params.entry_id}/complete`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "inbox_dismiss",
		label: "Dismiss Inbox Entry",
		description: "Dismiss an inbox entry as failed or cancelled with a reason.",
		promptSnippet: "Dismiss an inbox entry as failed or cancelled with a reason.",
		parameters: Type.Object({
			entry_id: Type.String({ description: "Inbox entry id from inbox_list." }),
			outcome: Type.Union([
				Type.Literal("failed"),
				Type.Literal("cancelled"),
			], { description: "Terminal state to transition the entry to." }),
			reason: Type.String({ description: "Explanation stored as the entry's error field." }),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = {
					sessionId,
					outcome: params.outcome,
					reason: params.reason,
				};
				return ok(await api("POST", `/api/staff/${staffId}/inbox/${params.entry_id}/dismiss`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	if (process.env.BOBBIT_DEBUG) console.log(`[inbox-tools] Registered 3 inbox tools for session ${sessionId}, staff ${staffId}`);
}

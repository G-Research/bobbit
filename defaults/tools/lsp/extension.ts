/**
 * LSP code-intelligence tools. Seven tools that wrap the gateway-side
 * `LspSupervisor` over HTTP (mirrors how `bash_bg` reaches back to the
 * gateway from inside a sandbox).
 *
 * Tool descriptions and parameter descriptions are budget-pinned by
 * `tests/tool-description-budget.test.ts` — keep tool description ≤ 150
 * chars, parameter descriptions ≤ 80 chars.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

function resolveGateway(): { baseUrl: string; token: string } {
	let token = "";
	let baseUrl = "";
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		token = envToken;
		baseUrl = envUrl.replace(/\/+$/, "");
		return { baseUrl, token };
	}
	try {
		const stateDir = process.env.BOBBIT_DIR
			? path.join(process.env.BOBBIT_DIR, "state")
			: path.join(homedir(), ".pi");
		const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
		token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
		baseUrl = fs.readFileSync(path.join(stateDir, "gateway-url"), "utf-8").trim().replace(/\/+$/, "");
	} catch {
		console.error("[lsp-tool] Cannot read gateway credentials");
	}
	return { baseUrl, token };
}

export default function (pi: ExtensionAPI) {
	const { baseUrl, token } = resolveGateway();

	async function getState(body: Record<string, unknown>): Promise<string> {
		try {
			const params = new URLSearchParams();
			params.set("cwd", String(body.cwd ?? process.cwd()));
			if (typeof body.path === "string") params.set("path", body.path);
			const res = await fetch(`${baseUrl}/api/lsp/state?${params}`, {
				headers: { "Authorization": `Bearer ${token}` },
			});
			if (!res.ok) return "unknown";
			const j = await res.json() as { state?: string };
			return j?.state ?? "unknown";
		} catch { return "unknown"; }
	}

	// Finding #2: emit a progress status line if the server is still cold
	// after ~500ms. Mirrors the `bash` streaming-status pattern by surfacing a
	// text chunk via `onUpdate`.
	async function callLsp(
		method: string,
		body: Record<string, unknown>,
		onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void,
	): Promise<unknown> {
		const fullBody = { ...body, cwd: body.cwd ?? process.cwd() };
		let announced = false;
		const progressTimer = setTimeout(async () => {
			if (announced || !onUpdate) return;
			const state = await getState(fullBody);
			if (announced) return;
			if (state === "starting" || state === "cold") {
				announced = true;
				onUpdate({
					content: [{ type: "text", text: "starting typescript-language-server (≈3s)…" }],
					details: { lspStatus: state },
				});
			}
		}, 500);
		try {
			const res = await fetch(`${baseUrl}/api/lsp/${method}`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(fullBody),
			});
			if (!res.ok) {
				const t = await res.text();
				throw new Error(`/api/lsp/${method} failed (${res.status}): ${t}`);
			}
			return await res.json();
		} finally {
			clearTimeout(progressTimer);
		}
	}

	const asText = (data: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: {},
	});

	const pathParam = Type.String({ description: "File path relative to session cwd." });
	const lineParam = Type.Number({ description: "0-indexed line (LSP-native)." });
	const charParam = Type.Number({ description: "0-indexed column in the line." });

	pi.registerTool({
		name: "lsp_definition",
		description: "Go to symbol definition. Prefer over grep+read for symbol lookups. 0-indexed line/char.",
		parameters: Type.Object({
			path: pathParam, line: lineParam, character: charParam,
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("definition", args, onUpdate)); }
			catch (err: any) { return asText({ error: "lsp_unavailable", message: String(err?.message ?? err) }); }
		},
	});

	pi.registerTool({
		name: "lsp_references",
		description: "Find all symbol references. Prefer over grep for symbol callsites. 0-indexed line/char.",
		parameters: Type.Object({
			path: pathParam, line: lineParam, character: charParam,
			includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration site (default true)." })),
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("references", args, onUpdate)); }
			catch (err: any) { return asText({ error: "lsp_unavailable", message: String(err?.message ?? err) }); }
		},
	});

	pi.registerTool({
		name: "lsp_hover",
		description: "Type/signature/docs for a symbol. Prefer over reading the file. 0-indexed line/char.",
		parameters: Type.Object({
			path: pathParam, line: lineParam, character: charParam,
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("hover", args, onUpdate)); }
			catch (err: any) { return asText({ error: "lsp_unavailable", message: String(err?.message ?? err) }); }
		},
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		description: "Type errors for a file or workspace. Prefer over npm run check in the edit loop.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "File path relative to cwd; omit for workspace." })),
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("diagnostics", args, onUpdate)); }
			catch (err: any) { return asText({ error: "lsp_unavailable", message: String(err?.message ?? err) }); }
		},
	});

	pi.registerTool({
		name: "lsp_document_symbols",
		description: "List symbols (classes, functions, vars) in a file as a tree. Prefer over read+scan to orient.",
		parameters: Type.Object({ path: pathParam }),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("document_symbols", args, onUpdate)); }
			catch (err: any) { return asText({ error: "lsp_unavailable", message: String(err?.message ?? err) }); }
		},
	});

	pi.registerTool({
		name: "lsp_workspace_symbol",
		description: "Symbol search across worktree. Prefer over grep for 'where is X defined'. Returns up to 100 hits.",
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name substring; fuzzy where supported." }),
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("workspace_symbol", args, onUpdate)); }
			catch (err: any) { return asText({ error: "lsp_unavailable", message: String(err?.message ?? err) }); }
		},
	});

	pi.registerTool({
		name: "lsp_rename",
		description: "Safe rename across files; returns WorkspaceEdit. Prefer over hand-edits. 0-indexed line/char.",
		parameters: Type.Object({
			path: pathParam, line: lineParam, character: charParam,
			newName: Type.String({ description: "New symbol name." }),
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("rename", args, onUpdate)); }
			catch (err: any) { return asText({ error: "lsp_unavailable", message: String(err?.message ?? err) }); }
		},
	});
}

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

/** Methods that returned HTTP 404 this process lifetime — cached to avoid re-hitting the gateway. */
const routeMissing404Cache = new Set<string>();

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
			// SECURITY: cwd must come from trusted runtime context only, never
			// from `body` (which is LLM-supplied). Otherwise the model could
			// override the worktree boundary that supervisor.ts's path-containment
			// check relies on.
			params.set("cwd", process.env.BOBBIT_HOST_CWD ?? process.cwd());
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
		if (routeMissing404Cache.has(method)) {
			return {
				error: "lsp_route_missing",
				message: `LSP route /api/lsp/${method} not registered on the gateway — likely a server build regression. Notify the operator; do not silently fall back to grep on every subsequent call.`,
			};
		}
		// Prefer BOBBIT_HOST_CWD when running inside a container — process.cwd()
		// would be the container path, but the gateway's /api/lsp/* routes
		// need the host-side cwd to spawn the LSP server correctly.
		// SECURITY: cwd is derived from trusted runtime context only. Never
		// honour `body.cwd` — it's LLM-supplied and would let the model
		// bypass the worktree boundary enforced in supervisor.ts.
		const trustedCwd = process.env.BOBBIT_HOST_CWD ?? process.cwd();
		const fullBody = { ...body, cwd: trustedCwd };
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
			if (res.status === 404) {
				routeMissing404Cache.add(method);
				return {
					error: "lsp_route_missing",
					message: `LSP route /api/lsp/${method} not registered on the gateway — likely a server build regression. Notify the operator; do not silently fall back to grep on every subsequent call.`,
				};
			}
			if (res.status >= 500) {
				let errMsg = `HTTP ${res.status}`;
				try {
					const errBody = await res.json() as Record<string, unknown>;
					errMsg = String(errBody?.message ?? errBody?.error ?? errMsg);
				} catch { /* ignore */ }
				throw new Error(`/api/lsp/${method} failed (${res.status}): ${errMsg}`);
			}
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
			catch (err: any) {
			const msg = String(err?.message ?? err);
			const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
			return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
		}
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
			catch (err: any) {
			const msg = String(err?.message ?? err);
			const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
			return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
		}
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
			catch (err: any) {
			const msg = String(err?.message ?? err);
			const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
			return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
		}
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
			catch (err: any) {
			const msg = String(err?.message ?? err);
			const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
			return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
		}
		},
	});

	pi.registerTool({
		name: "lsp_document_symbols",
		description: "List symbols (classes, functions, vars) in a file as a tree. Prefer over read+scan to orient.",
		parameters: Type.Object({ path: pathParam }),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("document_symbols", args, onUpdate)); }
			catch (err: any) {
			const msg = String(err?.message ?? err);
			const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
			return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
		}
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
			catch (err: any) {
			const msg = String(err?.message ?? err);
			const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
			return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
		}
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
			catch (err: any) {
			const msg = String(err?.message ?? err);
			const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
			return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
		}
		},
	});
}

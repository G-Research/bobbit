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

	type WsHit = {
		name: string;
		kind?: number;
		path: string;
		range: { start: { line: number; character: number }; end: { line: number; character: number } };
		containerName?: string;
	};

	type ResolveOk = {
		kind: "ok";
		args: Record<string, unknown>;
		resolvedFrom?: { symbolName: string; matched: string };
	};
	type ResolveErr = {
		kind: "error";
		payload: Record<string, unknown>;
	};
	type ResolveResult = ResolveOk | ResolveErr;

	/**
	 * Shorthand resolver shared by lsp_definition / lsp_references / lsp_hover.
	 *
	 * - Explicit (line, character) coordinates pass through unchanged.
	 * - `symbolName` is resolved via callLsp("workspace_symbol", { query }).
	 *   Hits are filtered by exact `name === symbolName`, then optionally
	 *   narrowed by the `path` hint (exact path → same directory → first hit).
	 * - Returns `{ error: "lsp_symbol_not_found", ... }` when no exact-name
	 *   hits exist, and `{ ambiguous: true, ... }` when multiple candidates
	 *   remain after applying the hint.
	 */
	async function resolveShorthand(
		args: Record<string, any>,
		onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void,
	): Promise<ResolveResult> {
		const hasExplicit = typeof args.line === "number" && typeof args.character === "number";
		if (hasExplicit || !args.symbolName) {
			return { kind: "ok", args };
		}
		const symbolName = String(args.symbolName);
		const raw = await callLsp("workspace_symbol", { query: symbolName }, onUpdate);
		if (raw && typeof raw === "object" && !Array.isArray(raw) && "error" in (raw as any)) {
			// Pass through gateway-level errors (lsp_unavailable, lsp_route_missing, ...).
			return { kind: "error", payload: raw as Record<string, unknown> };
		}
		const allHits: WsHit[] = Array.isArray(raw) ? (raw as WsHit[]) : [];
		// Exact-name match first; workspace_symbol is fuzzy and would otherwise
		// surface unrelated names (e.g. query "add" → "addUser").
		const exact = allHits.filter(h => h && h.name === symbolName && h.range && h.path);
		const hits = exact.length > 0 ? exact : [];

		if (hits.length === 0) {
			return {
				kind: "error",
				payload: {
					error: "lsp_symbol_not_found",
					message: `No symbol matching "${symbolName}" found in workspace`,
					hint: "Pass (path, line, character) explicitly, or refine the symbolName.",
				},
			};
		}

		const hint = typeof args.path === "string" ? args.path : undefined;
		let preferred: WsHit | undefined;
		let ambiguous = false;

		if (hint) {
			const exactPath = hits.find(h => h.path === hint);
			if (exactPath) {
				preferred = exactPath;
			} else {
				// The hint file itself isn't a definition site. Treat it as a
				// use-site: locate `symbolName` in the file and dispatch from
				// that coordinate. The LSP server then resolves to the real
				// definition the use-site refers to — semantically what the
				// caller meant by passing the hint.
				//
				// Textual `\bword\b` matching alone is unsafe: it also hits
				// comments, string literals, and unrelated identifiers. Probe
				// each candidate via callLsp("definition", ...) and pick the
				// first that the language server recognises as a real symbol
				// reference (non-empty result). Probing with "definition" is
				// reliable across all three shorthand consumers (definition /
				// references / hover) — a position with a valid definition
				// also has valid references and hover.
				const candidates = findUseSiteCandidates(symbolName, hint);
				for (const c of candidates) {
					let probe: unknown;
					try {
						probe = await callLsp("definition", { path: hint, line: c.line, character: c.character }, onUpdate);
					} catch { continue; }
					if (!isValidProbeResult(probe)) continue;
					const resolvedArgs: Record<string, unknown> = { ...args };
					delete resolvedArgs.symbolName;
					resolvedArgs.path = hint;
					resolvedArgs.line = c.line;
					resolvedArgs.character = c.character;
					return {
						kind: "ok",
						args: resolvedArgs,
						resolvedFrom: {
							symbolName,
							matched: `${hint}:${c.line + 1} (use-site)`,
						},
					};
				}
				const hintDir = path.posix.dirname(hint.replace(/\\/g, "/"));
				const sameDir = hits.filter(h => path.posix.dirname(h.path.replace(/\\/g, "/")) === hintDir);
				if (sameDir.length === 1) {
					preferred = sameDir[0];
				} else if (sameDir.length > 1) {
					// Multiple in the same directory and no use-site in hint file → ambiguous.
					ambiguous = true;
				} else {
					// Hint doesn't match any candidate's path or directory — fall
					// back to first hit (preserves "path is just a hint" semantics).
					preferred = hits[0];
				}
			}
		} else if (hits.length === 1) {
			preferred = hits[0];
		} else {
			ambiguous = true;
		}

		if (ambiguous || !preferred) {
			return {
				kind: "error",
				payload: {
					ambiguous: true,
					symbol: symbolName,
					candidates: hits,
					hint: "Pass `path` to narrow, or use a more specific symbolName.",
				},
			};
		}

		const resolvedArgs: Record<string, unknown> = { ...args };
		delete resolvedArgs.symbolName;
		resolvedArgs.path = preferred.path;
		resolvedArgs.line = preferred.range.start.line;
		resolvedArgs.character = preferred.range.start.character;
		return {
			kind: "ok",
			args: resolvedArgs,
			resolvedFrom: {
				symbolName,
				matched: `${preferred.path}:${preferred.range.start.line + 1}`,
			},
		};
	}

	/**
	 * Enumerate all word-boundary occurrences of `symbol` in `hintRel`
	 * (session-cwd-relative), in document order. Returns 0-indexed line/char
	 * of each identifier start. The caller is expected to validate each
	 * candidate via the language server — purely-textual matches include
	 * comments, strings, and unrelated identifiers.
	 */
	function findUseSiteCandidates(symbol: string, hintRel: string): Array<{ line: number; character: number }> {
		const out: Array<{ line: number; character: number }> = [];
		try {
			const cwd = process.env.BOBBIT_HOST_CWD ?? process.cwd();
			const abs = path.resolve(cwd, hintRel);
			const text = fs.readFileSync(abs, "utf-8");
			const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const re = new RegExp(`\\b${escaped}\\b`, "g");
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				re.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = re.exec(lines[i])) !== null) {
					out.push({ line: i, character: m.index });
					if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width
				}
			}
		} catch { /* file missing or unreadable — caller falls back to other heuristics */ }
		return out;
	}

	/**
	 * A use-site probe is "valid" when the LSP returns a real symbol — a
	 * non-empty Location array or a non-null/non-error object. Definition
	 * requests against comments, strings, whitespace, or unrelated words
	 * resolve to null or [] from typescript-language-server.
	 */
	function isValidProbeResult(probe: unknown): boolean {
		if (probe === null || probe === undefined) return false;
		if (Array.isArray(probe)) return probe.length > 0;
		if (typeof probe === "object") {
			const obj = probe as Record<string, unknown>;
			if (typeof obj.error === "string") return false;
			return Object.keys(obj).length > 0;
		}
		return false;
	}

	/** Decorate a successful shorthand result with `resolvedFrom`. */
	function decorate(result: unknown, resolvedFrom: { symbolName: string; matched: string }): unknown {
		if (result && typeof result === "object" && !Array.isArray(result)) {
			return { resolvedFrom, ...(result as Record<string, unknown>) };
		}
		return { resolvedFrom, result };
	}

	function handleLspError(err: any) {
		const msg = String(err?.message ?? err);
		const isNetworkErr = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ENOTFOUND");
		return asText({ error: isNetworkErr ? "lsp_gateway_unreachable" : "lsp_unavailable", message: msg });
	}

	const pathParam = Type.String({ description: "File path relative to session cwd." });
	const pathParamOptional = Type.Optional(Type.String({ description: "File path; required with line/char or as hint for symbolName." }));
	const lineParam = Type.Optional(Type.Number({ description: "0-indexed line (LSP-native). Omit when using symbolName." }));
	const charParam = Type.Optional(Type.Number({ description: "0-indexed column. Omit when using symbolName." }));
	const symbolNameParam = Type.Optional(Type.String({ description: "Resolve via workspace_symbol; alternative to (line, character)." }));

	pi.registerTool({
		name: "lsp_definition",
		description: "Go to definition. Pass symbolName OR (path, line, char). Prefer over grep+read. 0-indexed.",
		parameters: Type.Object({
			path: pathParamOptional, symbolName: symbolNameParam, line: lineParam, character: charParam,
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try {
				const r = await resolveShorthand(args, onUpdate);
				if (r.kind === "error") return asText(r.payload);
				const result = await callLsp("definition", r.args, onUpdate);
				return asText(r.resolvedFrom ? decorate(result, r.resolvedFrom) : result);
			} catch (err: any) { return handleLspError(err); }
		},
	});

	pi.registerTool({
		name: "lsp_references",
		description: "Find references. Pass symbolName OR (path, line, char). Prefer over grep for callsites. 0-indexed.",
		parameters: Type.Object({
			path: pathParamOptional, symbolName: symbolNameParam, line: lineParam, character: charParam,
			includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration site (default true)." })),
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try {
				const r = await resolveShorthand(args, onUpdate);
				if (r.kind === "error") return asText(r.payload);
				const result = await callLsp("references", r.args, onUpdate);
				return asText(r.resolvedFrom ? decorate(result, r.resolvedFrom) : result);
			} catch (err: any) { return handleLspError(err); }
		},
	});

	pi.registerTool({
		name: "lsp_hover",
		description: "Type/signature/docs. Pass symbolName OR (path, line, char). Prefer over reading the file. 0-indexed.",
		parameters: Type.Object({
			path: pathParamOptional, symbolName: symbolNameParam, line: lineParam, character: charParam,
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try {
				const r = await resolveShorthand(args, onUpdate);
				if (r.kind === "error") return asText(r.payload);
				const result = await callLsp("hover", r.args, onUpdate);
				return asText(r.resolvedFrom ? decorate(result, r.resolvedFrom) : result);
			} catch (err: any) { return handleLspError(err); }
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
			catch (err: any) { return handleLspError(err); }
		},
	});

	pi.registerTool({
		name: "lsp_document_symbols",
		description: "List symbols (classes, functions, vars) in a file as a tree. Prefer over read+scan to orient.",
		parameters: Type.Object({ path: pathParam }),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("document_symbols", args, onUpdate)); }
			catch (err: any) { return handleLspError(err); }
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
			catch (err: any) { return handleLspError(err); }
		},
	});

	pi.registerTool({
		name: "lsp_rename",
		description: "Safe rename across files; returns WorkspaceEdit. Prefer over hand-edits. 0-indexed line/char.",
		parameters: Type.Object({
			path: pathParam, line: Type.Number({ description: "0-indexed line (LSP-native)." }), character: Type.Number({ description: "0-indexed column in the line." }),
			newName: Type.String({ description: "New symbol name." }),
		}),
		async execute(_id, args: any, _abort: any, onUpdate: any) {
			try { return asText(await callLsp("rename", args, onUpdate)); }
			catch (err: any) { return handleLspError(err); }
		},
	});
}

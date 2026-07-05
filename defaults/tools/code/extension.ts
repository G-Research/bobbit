/**
 * `code_*` — wave 1 of the LSP product tool group
 * (docs/design/lsp-product-tools.md, F6). TS-only navigation backed by a
 * gateway-owned, per-worktree tsserver instance (`TsServerSupervisor`,
 * `src/server/lsp/supervisor.ts`) reached over HTTP exactly like `orient`/
 * `search` (`defaults/tools/harness/extension.ts`) — the tool process and
 * the gateway are separate processes even though the supervisor lives
 * in-process on the gateway.
 *
 * Every tool call proxies to `GET /api/internal/lsp/<op>` (see
 * `src/server/routes/lsp-routes.ts`). The route NEVER throws for an ordinary
 * "LSP isn't usable right now" outcome (missing tsconfig.json, sandboxed
 * session, tsserver crash/timeout) — it responds 200 with a typed
 * `{ available: false, reason, retryable? }` body, which these tools render
 * as a plain-text `[unavailable] ...` result rather than `isError` (this is
 * an expected, common outcome an agent should read as "fall back to
 * grep/rg", not a broken tool call). `isError` is reserved for genuine
 * request/transport failures (bad params, auth/network failure).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readGatewayCreds, apiCallDetailed, type ApiCallDetailedResult } from "../_shared/gateway.ts";

type LspOp = "definition" | "references" | "hover" | "symbols";

async function callLsp(op: LspOp, query: Record<string, string | number | undefined>): Promise<ApiCallDetailedResult | { error: string }> {
	const creds = readGatewayCreds();
	if ("error" in creds) return creds;
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) {
		if (v !== undefined) qs.set(k, String(v));
	}
	return apiCallDetailed(creds, "GET", `/api/internal/lsp/${op}?${qs.toString()}`, undefined, {
		extraHeaders: { "X-Bobbit-Session-Id": process.env.BOBBIT_SESSION_ID || "" },
	});
}

function unavailableLine(body: any): string {
	return `[unavailable] ${body.reason}${body.retryable ? " (retryable — the project may still be loading)" : ""}`;
}

function formatLocations(noun: string, body: any): string {
	if (body?.available === false) return unavailableLine(body);
	const locs: any[] = Array.isArray(body?.locations) ? body.locations : [];
	const lines = [
		`${locs.length} of ${body?.totalCount ?? locs.length} ${noun}${body?.totalCount === 1 ? "" : "s"}${body?.truncated ? " (truncated)" : ""}:`,
		...locs.map((l) => `- ${l.relativeFile ?? l.file}:${l.line}:${l.col}`),
	];
	return lines.join("\n");
}

function formatHover(body: any): string {
	if (body?.available === false) return unavailableLine(body);
	const contents = typeof body?.contents === "string" ? body.contents.trim() : "";
	return contents.length > 0 ? contents : "(no hover info at this position)";
}

function formatSymbols(body: any): string {
	if (body?.available === false) return unavailableLine(body);
	const syms: any[] = Array.isArray(body?.symbols) ? body.symbols : [];
	const lines = [
		`${syms.length} of ${body?.totalCount ?? syms.length} symbol${body?.totalCount === 1 ? "" : "s"}${body?.truncated ? " (truncated)" : ""} [${body?.mode}]:`,
		...syms.map((s) =>
			body?.mode === "workspace" ? `- ${s.name} (${s.kind}) ${s.relativeFile ?? s.file}:${s.line}:${s.col}` : `- ${s.name} (${s.kind}) :${s.line}`,
		),
	];
	return lines.join("\n");
}

/** Shared response handling: transport/auth failure -> isError; 4xx from the route (bad params/session) -> isError; 200 (available or not) -> plain-text render via `format`. */
async function runLspTool(op: LspOp, query: Record<string, string | number | undefined>, format: (body: any) => string) {
	let resp: ApiCallDetailedResult | { error: string };
	try {
		resp = await callLsp(op, query);
	} catch (err: any) {
		return { isError: true, content: [{ type: "text", text: `error: ${err?.message ?? String(err)}` }] };
	}
	if ("error" in resp) {
		return { isError: true, content: [{ type: "text", text: `error: ${resp.error}` }] };
	}
	if (!resp.ok) {
		const msg = typeof resp.body === "object" && resp.body !== null && "error" in (resp.body as any)
			? String((resp.body as any).error)
			: `HTTP ${resp.status}`;
		return { isError: true, content: [{ type: "text", text: `error: ${msg}` }] };
	}
	return { content: [{ type: "text", text: format(resp.body) }], details: resp.body as Record<string, unknown> };
}

const FILE_PARAM = Type.String({ description: "File path (relative to your worktree, or absolute)." });
const LINE_PARAM = Type.Number({ description: "1-based line number." });
const COL_PARAM = Type.Number({ description: "1-based column number." });

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "code_definition",
		label: "Code: Definition",
		description: "Find where a TypeScript symbol at a file position is defined (TS-only, needs tsconfig.json).",
		promptSnippet: "code_definition(file, line, col) - Jump to a TS symbol's definition. 1-based line/col.",
		promptGuidelines: [
			"Prefer code_definition() over grep when you have an exact file:line:col for a TS symbol.",
			"An '[unavailable]' result means fall back to grep/rg — not a broken tool call (e.g. no tsconfig.json here).",
		],
		parameters: Type.Object({ file: FILE_PARAM, line: LINE_PARAM, col: COL_PARAM }),
		async execute(_toolCallId, params: any) {
			return runLspTool("definition", { file: params.file, line: params.line, col: params.col }, (b) => formatLocations("location", b));
		},
	});

	pi.registerTool({
		name: "code_references",
		label: "Code: References",
		description: "Find all references to a TypeScript symbol at a file position (TS-only, needs tsconfig.json).",
		promptSnippet: "code_references(file, line, col) - Find all call sites of a TS symbol. 1-based line/col.",
		promptGuidelines: [
			"Results are capped (order of 50); a 'truncated' note means more exist — narrow the query instead of assuming completeness.",
		],
		parameters: Type.Object({ file: FILE_PARAM, line: LINE_PARAM, col: COL_PARAM }),
		async execute(_toolCallId, params: any) {
			return runLspTool("references", { file: params.file, line: params.line, col: params.col }, (b) => formatLocations("reference", b));
		},
	});

	pi.registerTool({
		name: "code_hover",
		label: "Code: Hover",
		description: "Show type and doc info for a TypeScript symbol at a file position (TS-only).",
		promptSnippet: "code_hover(file, line, col) - Get the type/doc text for a TS symbol. 1-based line/col.",
		promptGuidelines: [
			"Use this instead of re-reading a whole file to figure out a variable's inferred type.",
		],
		parameters: Type.Object({ file: FILE_PARAM, line: LINE_PARAM, col: COL_PARAM }),
		async execute(_toolCallId, params: any) {
			return runLspTool("hover", { file: params.file, line: params.line, col: params.col }, formatHover);
		},
	});

	pi.registerTool({
		name: "code_symbols",
		label: "Code: Symbols",
		description: "List symbols in a TypeScript file, or search project-wide with a query (TS-only).",
		promptSnippet: "code_symbols(file, query?) - List a file's symbols, or project-wide search with query.",
		promptGuidelines: [
			"Omit query for a single file's outline; set query for a project-wide fuzzy symbol search anchored at file.",
		],
		parameters: Type.Object({
			file: FILE_PARAM,
			query: Type.Optional(Type.String({ description: "Project-wide symbol search text; omit for this file's own symbols." })),
		}),
		async execute(_toolCallId, params: any) {
			return runLspTool("symbols", { file: params.file, query: params.query }, formatSymbols);
		},
	});
};

export default extension;

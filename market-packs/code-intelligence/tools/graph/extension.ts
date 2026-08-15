import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { GRAPH_QUERY_CAPS } from "../../src/graph-query.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_OUTPUT_BYTES = 48 * 1024;
const GRAPH_REVIEW_SNIPPET = "Graph: read-only breadth leads only; stale/base-fallback results cannot establish current impact—read cited source and callers.";
const GRAPH_REVIEW_GUIDELINES = [
	"Graph tools are read-only and return bounded component-labelled results.",
	"Use graph results as breadth leads, not proof of current impact.",
	"Stale or base-fallback results cannot establish current impact; verify current source before relying on them.",
	"Before a finding or approval, use read on every cited source and caller.",
	"v1 has no cross-repository edges; follow results only within their labelled component.",
] as const;

type Json = Record<string, unknown>;

function stateDir(): string {
	return process.env.BOBBIT_DIR ? path.join(process.env.BOBBIT_DIR, "state") : path.join(os.homedir(), ".pi");
}

function credentials(): { baseUrl: string; token: string } | null {
	try {
		const dir = stateDir();
		const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
		const baseUrl = fs.readFileSync(path.join(dir, "gateway-url"), "utf8").trim().replace(/\/+$/, "");
		const token = fs.readFileSync(path.join(dir, tokenFile), "utf8").trim();
		if (baseUrl && token) return { baseUrl, token };
	} catch { /* fall back to spawn-time credentials */ }
	const baseUrl = process.env.BOBBIT_GATEWAY_URL?.trim().replace(/\/+$/, "");
	const token = process.env.BOBBIT_TOKEN?.trim();
	return baseUrl && token ? { baseUrl, token } : null;
}

function object(value: unknown): Json {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function textResult(text: string, details?: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		...(details === undefined ? {} : { details }),
		...(isError ? { isError: true } : {}),
	};
}

function integer(value: unknown, fallback: number, maximum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}

function componentList(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	const safe = values
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(Boolean)
		.slice(0, GRAPH_QUERY_CAPS.components);
	return safe.length > 0 ? [...new Set(safe)] : undefined;
}

function boundedOperation(operation: string, raw: Json): Json {
	const out: Json = { op: operation };
	for (const key of ["symbol", "node", "from", "to", "query", "component", "direction"]) {
		if (typeof raw[key] === "string" && raw[key].trim()) out[key] = raw[key].trim().slice(0, 2_000);
	}
	const components = componentList(raw.components);
	if (components) out.components = components;
	if (raw.includeDocs === true && operation === "query") out.includeDocs = true;
	if (operation === "affected" || operation === "neighbors" || operation === "path") out.maxDepth = integer(raw.maxDepth, 3, GRAPH_QUERY_CAPS.depth);
	if (operation !== "path" && operation !== "status") out.maxResults = integer(raw.maxResults, 20, GRAPH_QUERY_CAPS.results);
	return out;
}

function routeFailure(value: unknown): Json | undefined {
	const body = object(value);
	return body.ok === false ? body : undefined;
}

function stringifyBounded(value: unknown): { text: string; truncated: boolean; omittedBytes: number } {
	let text: string;
	try { text = JSON.stringify(value, null, 2); } catch { text = JSON.stringify({ error: "graph route returned a non-serializable response" }); }
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= MAX_OUTPUT_BYTES) return { text, truncated: false, omittedBytes: 0 };
	const clipped = Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
	return { text: `${clipped}\n\n[Graph response truncated; ${bytes - MAX_OUTPUT_BYTES} bytes omitted.]`, truncated: true, omittedBytes: bytes - MAX_OUTPUT_BYTES };
}

async function parseResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	let data: unknown = text;
	try { data = JSON.parse(text); } catch { /* preserve non-JSON diagnostic */ }
	if (!response.ok) {
		const body = object(data);
		throw Object.assign(new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`), { data, status: response.status });
	}
	return data;
}

/** Call only the pack's allowlisted `status` route. The gateway derives the pack
 * identity from a verified surface token; tool arguments never select a store,
 * route module, filesystem path, or project identity. */
async function callGraphRoute(tool: string, operation: string, args: Json, sessionId: string): Promise<unknown> {
	const creds = credentials();
	if (!creds) throw new Error("Bobbit gateway credentials are unavailable");
	const headers = { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json", "X-Bobbit-Session-Id": sessionId };
	const surface = await fetch(`${creds.baseUrl}/api/ext/surface-token`, {
		method: "POST", headers, body: JSON.stringify({ sessionId, tool }),
	}).then(parseResponse) as { token?: unknown };
	if (typeof surface.token !== "string" || !surface.token) throw new Error("Graph route surface token was empty");
	return fetch(`${creds.baseUrl}/api/ext/route/status`, {
		method: "POST",
		headers,
		body: JSON.stringify({ sessionId, surfaceToken: surface.token, init: { method: "POST", body: boundedOperation(operation, args) } }),
	}).then(parseResponse);
}

function registerGraphTool(pi: any, sessionId: string, spec: {
	name: string;
	label: string;
	description: string;
	operation: string;
	parameters: any;
}) {
	pi.registerTool({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: GRAPH_REVIEW_SNIPPET,
		promptGuidelines: GRAPH_REVIEW_GUIDELINES,
		parameters: spec.parameters,
		async execute(_toolCallId: string, args: Record<string, unknown>) {
			try {
				const data = await callGraphRoute(spec.name, spec.operation, object(args), sessionId);
				const failure = routeFailure(data);
				if (failure) {
					const error = typeof failure.error === "string" ? failure.error : "GRAPH_ROUTE_FAILED";
					return textResult(`${spec.name} failed: ${error}`, { response: failure }, true);
				}
				const formatted = stringifyBounded(data);
				return textResult(formatted.text, { response: data, truncated: formatted.truncated, omittedBytes: formatted.omittedBytes });
			} catch (error: any) {
				const message = error?.message || String(error);
				return textResult(`${spec.name} failed: ${message}`, error?.data ?? { error: message, status: error?.status }, true);
			}
		},
	});
}

const extension: ExtensionFactory = (pi: any) => {
	const sessionId = process.env.BOBBIT_SESSION_ID;
	if (!sessionId) return;
	const component = Type.Optional(Type.String({ maxLength: 256 }));
	const maxResults = Type.Optional(Type.Number({ minimum: 1, maximum: GRAPH_QUERY_CAPS.results }));
	const maxDepth = Type.Optional(Type.Number({ minimum: 1, maximum: GRAPH_QUERY_CAPS.depth }));
	registerGraphTool(pi, sessionId, {
		name: "graph_affected", label: "Graph Affected", operation: "affected",
		description: "Read-only graph breadth leads for affected callers and likely impact; read cited source and callers before review findings.",
		parameters: Type.Object({ symbol: Type.String({ minLength: 1, maxLength: 2_000 }), component, maxResults, maxDepth }, { additionalProperties: false }),
	});
	registerGraphTool(pi, sessionId, {
		name: "graph_explain", label: "Graph Explain", operation: "explain",
		description: "Read-only graph breadth leads for node relationships; read cited source and callers before review findings.",
		parameters: Type.Object({ node: Type.String({ minLength: 1, maxLength: 2_000 }), component, maxResults }, { additionalProperties: false }),
	});
	registerGraphTool(pi, sessionId, {
		name: "graph_path", label: "Graph Path", operation: "path",
		description: "Read-only graph breadth leads for bounded component paths; read cited source and callers before review findings.",
		parameters: Type.Object({ from: Type.String({ minLength: 1, maxLength: 2_000 }), to: Type.String({ minLength: 1, maxLength: 2_000 }), component, maxDepth }, { additionalProperties: false }),
	});
	registerGraphTool(pi, sessionId, {
		name: "graph_neighbors", label: "Graph Neighbors", operation: "neighbors",
		description: "Read-only graph breadth leads for node neighbours; read cited source and callers before review findings.",
		parameters: Type.Object({ node: Type.String({ minLength: 1, maxLength: 2_000 }), direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")])), component, maxResults, maxDepth }, { additionalProperties: false }),
	});
	registerGraphTool(pi, sessionId, {
		name: "graph_query", label: "Graph Query", operation: "query",
		description: "Read-only graph breadth search; read cited source and callers before review findings. Code-tier results are default.",
		parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 2_000 }), component, components: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: GRAPH_QUERY_CAPS.components })), includeDocs: Type.Optional(Type.Boolean()), maxResults }, { additionalProperties: false }),
	});
	registerGraphTool(pi, sessionId, {
		name: "graph_status", label: "Graph Status", operation: "status",
		description: "Read-only graph freshness; stale or base-fallback status cannot prove current impact.",
		parameters: Type.Object({ component, components: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: GRAPH_QUERY_CAPS.components })) }, { additionalProperties: false }),
	});
};

export default extension;

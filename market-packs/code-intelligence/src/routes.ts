import { getGraphRuntime } from "./graph-runtime.js";

type RouteCtx = {
	projectId?: string;
	goalId?: string;
	sessionId?: string;
	host?: unknown;
	[key: string]: unknown;
};
type RouteReq = { method?: string; query?: Record<string, string>; body?: unknown };
type Body = Record<string, unknown>;

const MAX_COMPONENTS = 8;
const MAX_RESULTS = 100;
const MAX_DEPTH = 8;
const MAX_PATHS = 10;
const MAX_REQUEST_TEXT = 2_000;
const MAX_RESPONSE_BYTES = 96 * 1024;
const QUERY_OPS = new Set(["affected", "explain", "path", "neighbors", "query", "status"]);

function object(value: unknown): Body {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Body : {};
}

function string(value: unknown, maximum = MAX_REQUEST_TEXT): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function integer(value: unknown, fallback: number, maximum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}

function components(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	const found = raw
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(Boolean)
		.slice(0, MAX_COMPONENTS);
	return found.length > 0 ? [...new Set(found)] : undefined;
}

/** Re-validate every tool/panel request at the host boundary. In particular,
 * callers cannot nominate an on-disk graph, a store root, project, pack, or
 * arbitrary operation. The runtime additionally applies result caps. */
function boundedQuery(body: Body): { ok: true; value: Body } | { ok: false; error: string } {
	const op = string(body.op, 32);
	if (!op || !QUERY_OPS.has(op)) return { ok: false, error: "GRAPH_OPERATION_INVALID" };
	const out: Body = { op };
	for (const key of ["symbol", "node", "from", "to", "query", "component", "direction"]) {
		const value = string(body[key]);
		if (value) out[key] = value;
	}
	const selected = components(body.components);
	if (selected) out.components = selected;
	if (op === "query" && body.includeDocs === true) out.includeDocs = true;
	if (op === "affected" || op === "neighbors" || op === "path") out.maxDepth = integer(body.maxDepth, 3, MAX_DEPTH);
	if (op === "path") out.maxPaths = integer(body.maxPaths, 3, MAX_PATHS);
	if (op !== "path" && op !== "status") out.maxResults = integer(body.maxResults, 20, MAX_RESULTS);
	return { ok: true, value: out };
}

function responseWithinCap(value: unknown): unknown {
	let serialized: string;
	try { serialized = JSON.stringify(value); } catch { return { ok: false, error: "GRAPH_RESPONSE_NOT_SERIALIZABLE" }; }
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes <= MAX_RESPONSE_BYTES) return value;
	return {
		ok: false,
		error: "GRAPH_RESPONSE_CAPPED",
		message: "Graph response exceeded the host response cap; narrow the component or result limit.",
		omittedBytes: bytes - MAX_RESPONSE_BYTES,
	};
}

function method(req: RouteReq): string {
	return (req?.method ?? "GET").toUpperCase();
}

async function safely<T>(run: () => Promise<T>): Promise<T | { ok: false; error: string }> {
	try { return await run(); }
	catch (error: any) {
		// GraphRuntime records durable diagnostics. Route callers receive a stable,
		// path-free code/message rather than a host stack or filesystem details.
		return { ok: false, error: "GRAPH_RUNTIME_UNAVAILABLE", message: typeof error?.message === "string" ? error.message.slice(0, 500) : undefined };
	}
}

export const routes = {
	/** The single read RPC used by all six ordinary tools and the status panel.
	 * Query fan-out remains component-labelled in GraphQueryService; no route-level
	 * merged graph or cross-repository edges are introduced here. */
	status: async (ctx: RouteCtx, req: RouteReq) => {
		const body = object(req?.body);
		const requested = boundedQuery({ op: body.op ?? "status", ...body });
		if (!requested.ok) return { ok: false, error: requested.error };
		return responseWithinCap(await safely(async () => {
			const runtime = await getGraphRuntime(ctx);
			return requested.value.op === "status"
				? await runtime.status(ctx, requested.value)
				: await runtime.query(ctx, requested.value);
		}));
	},

	/** Configuration is data-declared only. There is deliberately no write path:
	 * no graph-specific project config API or caller-controlled storage location. */
	config: async (ctx: RouteCtx, req: RouteReq) => {
		if (method(req) !== "GET") return { ok: false, error: "GRAPH_CONFIG_READ_ONLY" };
		return responseWithinCap(await safely(async () => (await getGraphRuntime(ctx)).config(ctx)));
	},

	/** A manual rebuild is invoked and awaited on this route only. Until EP-8
	 * supplies the host lifecycle service it returns an explicit unavailable
	 * result; it never queues, detaches, or starts Graphify work. */
	rebuild: async (ctx: RouteCtx, req: RouteReq) => {
		if (method(req) !== "POST") return { ok: false, error: "GRAPH_REBUILD_POST_REQUIRED" };
		const body = object(req?.body);
		const selected = components(body.components ?? body.component);
		return responseWithinCap(await safely(async () => {
			const runtime = await getGraphRuntime(ctx);
			return runtime.rebuild(ctx, { source: "manual", ...(selected ? { components: selected } : {}) });
		}));
	},
};

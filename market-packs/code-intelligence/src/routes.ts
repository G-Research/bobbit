import { GRAPH_QUERY_CAPS } from "./graph-query.ts";
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
type GraphRouteRuntime = Pick<ReturnType<typeof getGraphRuntime>, "status" | "query" | "config" | "rebuild">;

let graphRuntimeFor = (ctx: RouteCtx): GraphRouteRuntime => getGraphRuntime(ctx);
/** Focused route tests inject a host facade without exposing an RPC override. */
export function __setGraphRuntimeForTests(resolver?: (ctx: RouteCtx) => GraphRouteRuntime): void {
	graphRuntimeFor = resolver ?? (ctx => getGraphRuntime(ctx));
}

const MAX_REQUEST_TEXT = 2_000;
const MAX_RESPONSE_BYTES = 96 * 1024;
const MAX_STATUS_COMPONENTS = GRAPH_QUERY_CAPS.components;
const MAX_STATUS_LANGUAGES = 32;
const MAX_STATUS_ITEMS = 32;
const QUERY_OPS = new Set(["affected", "explain", "path", "neighbors", "query", "status"]);
const GRAPH_STATES = new Set(["fresh", "building", "stale", "failed", "base-fallback"]);
const AGGREGATE_STATES = new Set(["current", "not-current", "limited", "updating", "no-graph-published"]);
const LSP_STATES = new Set(["disabled", "requires-toolchain", "ready", "unavailable", "unsupported"]);
const STRUCTURAL_STATES = new Set(["available", "unsupported"]);
const GRAPH_STALE_REASONS = new Set(["parent-advanced", "worktree-dirty", "base-rebuilt", "validation-failed", "version-changed", "missing-runtime"]);

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
		.slice(0, GRAPH_QUERY_CAPS.components);
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
	if (op === "affected" || op === "neighbors" || op === "path") out.maxDepth = integer(body.maxDepth, 3, GRAPH_QUERY_CAPS.depth);
	if (op !== "path" && op !== "status") out.maxResults = integer(body.maxResults, 20, GRAPH_QUERY_CAPS.results);
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

/**
 * The runtime owns status derivation. The route only validates its declared,
 * serializable projection before it crosses the extension-host boundary. This
 * prevents a future facade change from accidentally publishing host roots,
 * process diagnostics, or an undeclared state through this allowlisted seam.
 */
function declaredStatus(value: unknown): Body | undefined {
	const input = object(value);
	if (containsRawPath(input)) return undefined;
	const state = enumValue(input.state, AGGREGATE_STATES);
	if (!state) return undefined;
	const components = list(input.components, MAX_STATUS_COMPONENTS, componentStatus);
	if (!components) return undefined;
	const aggregate = aggregateStatus(input.aggregate);
	if (!aggregate) return undefined;

	const out: Body = { state, aggregate, components };
	const languages = list(input.languages, MAX_STATUS_LANGUAGES, languageStatus);
	if (input.languages !== undefined && !languages) return undefined;
	if (languages) out.languages = languages;
	const runtime = enumValue(input.runtime, new Set(["host", "sandbox"]));
	if (input.runtime !== undefined && !runtime) return undefined;
	if (runtime) out.runtime = runtime;
	if (input.noCrossRepoEdges !== true) return undefined;
	out.noCrossRepoEdges = true;
	const warning = fixedText(input.warning, "v1 has no cross-repo edges");
	if (input.warning !== undefined && !warning) return undefined;
	if (warning) out.warning = warning;
	const warnings = textList(input.warnings, MAX_STATUS_ITEMS);
	if (input.warnings !== undefined && !warnings) return undefined;
	if (warnings) out.warnings = warnings;
	const guidance = textList(input.guidance, MAX_STATUS_ITEMS);
	if (input.guidance !== undefined && !guidance) return undefined;
	if (guidance) out.guidance = guidance;
	const lifecycle = lifecycleStatus(input.lifecycle);
	if (input.lifecycle !== undefined && !lifecycle) return undefined;
	if (lifecycle) out.lifecycle = lifecycle;
	return out;
}

function declaredConfig(value: unknown): Body | undefined {
	const input = object(value);
	if (containsRawPath(input)) return undefined;
	const out: Body = {};
	if (input.readOnly !== true || input.storage !== "host-only" || input.noCrossRepoEdges !== true) return undefined;
	out.readOnly = true;
	out.storage = "host-only";
	out.noCrossRepoEdges = true;
	const tiers = tiersList(input.defaultTiers);
	if (input.defaultTiers !== undefined && !tiers) return undefined;
	if (tiers) out.defaultTiers = tiers;
	const docsOptIn = safeText(input.docsOptIn, 128);
	if (input.docsOptIn !== undefined && !docsOptIn) return undefined;
	if (docsOptIn) out.docsOptIn = docsOptIn;
	const lifecycle = lifecycleStatus(input.lifecycle);
	if (input.lifecycle !== undefined && !lifecycle) return undefined;
	if (lifecycle) out.lifecycle = lifecycle;
	const rebuild = manualRebuild(input.manualRebuild);
	if (input.manualRebuild !== undefined && !rebuild) return undefined;
	if (rebuild) out.manualRebuild = rebuild;
	const warning = fixedText(input.warning, "v1 has no cross-repo edges");
	if (input.warning !== undefined && !warning) return undefined;
	if (warning) out.warning = warning;
	return out;
}

function componentStatus(value: unknown): Body | undefined {
	const input = object(value);
	const component = componentLabel(input.component);
	const state = enumValue(input.state, new Set([...GRAPH_STATES, "unpublished"]));
	if (!component || !state) return undefined;
	const out: Body = { component, state };
	const staleReason = enumValue(input.staleReason, GRAPH_STALE_REASONS);
	if (input.staleReason !== undefined && !staleReason) return undefined;
	if (staleReason) out.staleReason = staleReason;
	for (const key of ["revision"] as const) {
		const text = safeText(input[key], 128);
		if (input[key] !== undefined && !text) return undefined;
		if (text) out[key] = text;
	}
	const revisions = revisionStatus(input.revisions);
	if (input.revisions !== undefined && !revisions) return undefined;
	if (revisions) out.revisions = revisions;
	const roots = list(input.roots, MAX_STATUS_ITEMS, rootStatus);
	if (input.roots !== undefined && !roots) return undefined;
	if (roots) out.roots = roots;
	const counts = numberRecord(input.counts, ["nodes", "edges", "bytes"]);
	if (input.counts !== undefined && !counts) return undefined;
	if (counts) out.counts = counts;
	const timing = numberRecord(input.timing, ["buildMs", "cloneMs", "deltaMs", "codeMs", "codeDocsMs"]);
	if (input.timing !== undefined && !timing) return undefined;
	if (timing) out.timing = timing;
	const languages = list(input.languages, MAX_STATUS_LANGUAGES, languageStatus);
	if (input.languages !== undefined && !languages) return undefined;
	if (languages) out.languages = languages;
	return out;
}

function languageStatus(value: unknown): Body | undefined {
	const input = object(value);
	const languageId = safeText(input.languageId, 64);
	const label = safeText(input.label, 128);
	const structuralSearch = enumValue(input.structuralSearch, STRUCTURAL_STATES);
	const lsp = lspStatus(input.lsp);
	if (!languageId || !label || !structuralSearch || !lsp) return undefined;
	const out: Body = { languageId, label, structuralSearch, lsp };
	const component = safeText(input.component, 128);
	if (input.component !== undefined && !component) return undefined;
	if (component) out.component = component;
	const evidence = detectionEvidence(input.evidence);
	if (input.evidence !== undefined && !evidence) return undefined;
	if (evidence) out.evidence = evidence;
	return out;
}

function lspStatus(value: unknown): Body | undefined {
	const input = object(value);
	const state = enumValue(input.state, LSP_STATES);
	if (!state) return undefined;
	const out: Body = { state };
	const actions = textList(input.actions, MAX_STATUS_ITEMS);
	if (input.actions !== undefined && !actions) return undefined;
	if (actions) out.actions = actions;
	for (const key of ["requirements", "missing"] as const) {
		const requirements = list(input[key], MAX_STATUS_ITEMS, requirementStatus);
		if (input[key] !== undefined && !requirements) return undefined;
		if (requirements) out[key] = requirements;
	}
	const reason = safeText(input.reason, MAX_REQUEST_TEXT);
	if (input.reason !== undefined && !reason) return undefined;
	if (reason) out.reason = reason;
	return out;
}

function detectionEvidence(value: unknown): Body | undefined {
	const input = object(value);
	const fileCount = safeNumber(input.fileCount);
	if (fileCount === undefined) return undefined;
	const matchedGlobs = textList(input.matchedGlobs, MAX_STATUS_ITEMS);
	const rootMarkers = textList(input.rootMarkers, MAX_STATUS_ITEMS);
	if (!matchedGlobs || !rootMarkers || (input.truncated !== undefined && typeof input.truncated !== "boolean")) return undefined;
	return { fileCount, matchedGlobs, rootMarkers, ...(input.truncated === true ? { truncated: true } : {}) };
}

function requirementStatus(value: unknown): Body | undefined {
	const input = object(value);
	const id = safeText(input.id, 128);
	const label = safeText(input.label, 256);
	const installHint = safeText(input.installHint, MAX_REQUEST_TEXT);
	if (!id || !label || !installHint) return undefined;
	const out: Body = { id, label, installHint };
	for (const key of ["executable", "layerId"] as const) {
		const text = safeText(input[key], 128);
		if (input[key] !== undefined && !text) return undefined;
		if (text) out[key] = text;
	}
	if (input.version !== undefined) {
		const version = object(input.version);
		const range = safeText(version.range, 128);
		const reason = safeText(version.reason, MAX_REQUEST_TEXT);
		if (!range || !reason) return undefined;
		out.version = { range, reason };
	}
	return out;
}

function componentLabel(value: unknown): Body | undefined {
	const input = object(value);
	const name = safeText(input.name, 128);
	// `.` is the declared label for a component rooted at its repository; it is
	// not a caller-supplied filesystem path.
	const repo = input.repo === "." ? "." : relativeText(input.repo, 512);
	if (!name || !repo) return undefined;
	const out: Body = { name, repo };
	const relativePath = relativeText(input.relativePath, 512);
	if (input.relativePath !== undefined && !relativePath) return undefined;
	if (relativePath) out.relativePath = relativePath;
	return out;
}

function revisionStatus(value: unknown): Body | undefined {
	const input = object(value);
	const baseRef = safeText(input.baseRef, 128);
	const baseRev = safeText(input.baseRev, 128);
	const headRev = safeText(input.headRev, 128);
	return baseRef && baseRev && headRev ? { baseRef, baseRev, headRev } : undefined;
}

function rootStatus(value: unknown): Body | undefined {
	if (typeof value === "string") {
		const tier = enumValue(value, new Set(["code", "docs"]));
		return tier ? { tier } : undefined;
	}
	const input = object(value);
	const tier = enumValue(input.tier, new Set(["code", "docs"]));
	if (!tier) return undefined;
	const out: Body = { tier };
	for (const key of ["label", "sourceRoot"] as const) {
		const text = safeText(input[key], 128);
		if (input[key] !== undefined && !text) return undefined;
		if (text) out[key] = text;
	}
	const relativePath = rootRelativeText(input.relativePath ?? input.path, 512);
	if ((input.relativePath !== undefined || input.path !== undefined) && !relativePath) return undefined;
	if (relativePath) out.path = relativePath;
	return out;
}

function aggregateStatus(value: unknown): Body | undefined {
	const input = object(value);
	const state = enumValue(input.state, AGGREGATE_STATES);
	const label = enumValue(input.label, new Set(["Current", "Updating", "Limited", "Not current", "No graph published"]));
	return state && label ? { state, label } : undefined;
}

function lifecycleStatus(value: unknown): Body | undefined {
	const input = object(value);
	if (input.automaticProcessing !== "unavailable" || input.pending !== "EP-8") return undefined;
	const message = safeText(input.message, MAX_REQUEST_TEXT);
	return message ? { automaticProcessing: "unavailable", pending: "EP-8", message } : undefined;
}

function manualRebuild(value: unknown): Body | undefined {
	const input = object(value);
	if (typeof input.routeOnly !== "boolean" || typeof input.available !== "boolean") return undefined;
	const out: Body = { routeOnly: input.routeOnly, available: input.available };
	const reason = safeText(input.reason, 256);
	if (input.reason !== undefined && !reason) return undefined;
	if (reason) out.reason = reason;
	return out;
}

function tiersList(value: unknown): string[] | undefined {
	const values = list(value, 2, item => typeof item === "string" && (item === "code" || item === "docs") ? item : undefined);
	return values?.length ? values : undefined;
}
function textList(value: unknown, maximum: number): string[] | undefined {
	return list(value, maximum, item => safeText(item, MAX_REQUEST_TEXT));
}
function list<T>(value: unknown, maximum: number, parse: (item: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(value) || value.length > maximum) return undefined;
	const parsed = value.map(parse);
	return parsed.some(item => item === undefined) ? undefined : parsed as T[];
}
function numberRecord(value: unknown, keys: readonly string[]): Body | undefined {
	const input = object(value);
	const out: Body = {};
	for (const key of keys) {
		const number = safeNumber(input[key]);
		if (input[key] !== undefined && number === undefined) return undefined;
		if (number !== undefined) out[key] = number;
	}
	return Object.keys(out).length ? out : undefined;
}
function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function enumValue(value: unknown, values: ReadonlySet<string>): string | undefined {
	return typeof value === "string" && values.has(value) ? value : undefined;
}
function fixedText(value: unknown, expected: string): string | undefined { return value === expected ? expected : undefined; }
function safeText(value: unknown, maximum: number): string | undefined {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) return undefined;
	return hasAbsolutePath(value) ? undefined : value.trim();
}
function relativeText(value: unknown, maximum: number): string | undefined {
	const text = safeText(value, maximum);
	if (!text || hasAbsolutePath(text) || text.replace(/\\/g, "/").split("/").some(part => !part || part === "." || part === "..")) return undefined;
	return text;
}
function rootRelativeText(value: unknown, maximum: number): string | undefined {
	return value === "." ? "." : relativeText(value, maximum);
}
function hasAbsolutePath(value: string): boolean {
	return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}
function containsRawPath(value: unknown, depth = 0): boolean {
	if (depth > 16) return true;
	if (typeof value === "string") return hasAbsolutePath(value) || /(?:^|[\s"'(])(?:\/|\\\\|[A-Za-z]:[\\/])/.test(value);
	if (Array.isArray(value)) return value.some(item => containsRawPath(item, depth + 1));
	if (!value || typeof value !== "object") return false;
	return Object.values(value).some(item => containsRawPath(item, depth + 1));
}

function method(req: RouteReq): string {
	return (req?.method ?? "GET").toUpperCase();
}

type GraphRouteFailure = { ok: false; error: "GRAPH_CONTEXT_PROJECT_REQUIRED" | "GRAPH_RUNTIME_UNAVAILABLE" };

function isRouteFailure(value: unknown): value is GraphRouteFailure {
	const body = object(value);
	return body.ok === false && (body.error === "GRAPH_CONTEXT_PROJECT_REQUIRED" || body.error === "GRAPH_RUNTIME_UNAVAILABLE");
}

async function safely<T>(run: () => Promise<T>): Promise<T | GraphRouteFailure> {
	try { return await run(); }
	catch (error) {
		// Preserve the one actionable, path-free identity failure. All other runtime
		// errors remain deliberately opaque so route responses never disclose host paths.
		if (error instanceof Error && error.message === "GRAPH_CONTEXT_PROJECT_REQUIRED") {
			return { ok: false, error: "GRAPH_CONTEXT_PROJECT_REQUIRED" };
		}
		return { ok: false, error: "GRAPH_RUNTIME_UNAVAILABLE" };
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
		const response = await safely(async () => {
			const runtime = await graphRuntimeFor(ctx);
			return requested.value.op === "status"
				? await runtime.status(ctx, requested.value)
				: await runtime.query(ctx, requested.value);
		});
		if (isRouteFailure(response)) return response;
		// Only the declared status projection takes this route. Query results have
		// their own graph-service schema, including source-relative match paths.
		if (requested.value.op === "status") {
			const status = declaredStatus(response);
			return responseWithinCap(status ?? { ok: false, error: "GRAPH_STATUS_DECLARATION_INVALID" });
		}
		return responseWithinCap(response);
	},

	/** Configuration is data-declared only. There is deliberately no write path:
	 * no graph-specific project config API or caller-controlled storage location. */
	config: async (ctx: RouteCtx, req: RouteReq) => {
		if (method(req) !== "GET") return { ok: false, error: "GRAPH_CONFIG_READ_ONLY" };
		const response = await safely(async () => (await graphRuntimeFor(ctx)).config(ctx));
		if (isRouteFailure(response)) return response;
		return responseWithinCap(declaredConfig(response) ?? { ok: false, error: "GRAPH_CONFIG_DECLARATION_INVALID" });
	},

	/** A manual rebuild is invoked and awaited on this route only. Until EP-8
	 * supplies the host lifecycle service it returns an explicit unavailable
	 * result; it never queues, detaches, or starts Graphify work. */
	rebuild: async (ctx: RouteCtx, req: RouteReq) => {
		if (method(req) !== "POST") return { ok: false, error: "GRAPH_REBUILD_POST_REQUIRED" };
		const body = object(req?.body);
		const selected = components(body.components ?? body.component);
		return responseWithinCap(await safely(async () => {
			const runtime = await graphRuntimeFor(ctx);
			return runtime.rebuild(ctx, { source: "manual", ...(selected ? { components: selected } : {}) });
		}));
	},
};

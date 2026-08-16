// Hindsight's five agent tools. They are intentionally only authenticated typed
// route adapters: no client, runtime, settings, grant, or secret implementation
// is imported here.

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_QUERY = 4_000;
const MAX_CONTENT = 16_000;
const MAX_ID = 512;

type Credentials = { baseUrl: string; token: string };

function credentials(): Credentials | undefined {
	const state = process.env.BOBBIT_DIR ? path.join(process.env.BOBBIT_DIR, "state") : path.join(homedir(), ".pi");
	const tokenFile = path.join(state, process.env.BOBBIT_DIR ? "token" : "gateway-token");
	const urlFile = path.join(state, "gateway-url");
	try {
		const token = fs.readFileSync(tokenFile, "utf8").trim();
		const baseUrl = fs.readFileSync(urlFile, "utf8").trim().replace(/\/+$/, "");
		if (token && baseUrl) return { token, baseUrl };
	} catch { /* sandbox env fallback below */ }
	const token = process.env.BOBBIT_TOKEN?.trim();
	const baseUrl = process.env.BOBBIT_GATEWAY_URL?.trim().replace(/\/+$/, "");
	return token && baseUrl ? { token, baseUrl } : undefined;
}

async function post(creds: Credentials, pathName: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
	const response = await fetch(`${creds.baseUrl}${pathName}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json", "x-bobbit-session-id": sessionId },
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	let data: unknown = text;
	try { data = JSON.parse(text); } catch { /* return bounded route error below */ }
	if (!response.ok) {
		const code = data && typeof data === "object" && "error" in data && typeof (data as { error?: unknown }).error === "string"
			? (data as { error: string }).error
			: `ROUTE_HTTP_${response.status}`;
		throw new Error(code.slice(0, 200));
	}
	return data;
}

/** Tool-bound surface tokens preserve the public, server-derived pack identity.
 * A tool never selects a pack or calls an arbitrary gateway URL. */
async function callRoute(tool: string, route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	const creds = credentials();
	const sessionId = process.env.BOBBIT_SESSION_ID?.trim();
	if (!creds || !sessionId) throw new Error("HINDSIGHT_ROUTE_UNAVAILABLE");
	const minted = await post(creds, "/api/ext/surface-token", sessionId, { sessionId, tool }, signal);
	const surfaceToken = minted && typeof minted === "object" && typeof (minted as { token?: unknown }).token === "string"
		? (minted as { token: string }).token
		: undefined;
	if (!surfaceToken) throw new Error("HINDSIGHT_ROUTE_UNAVAILABLE");
	return post(creds, `/api/ext/route/${encodeURIComponent(route)}`, sessionId, {
		sessionId,
		surfaceToken,
		init: { method: "POST", body },
	}, signal);
}

function bounded(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result && result.length <= limit ? result : undefined;
}

function toolResult(value: unknown) {
	const text = JSON.stringify(value, null, 2);
	return { content: [{ type: "text" as const, text: text.length <= 24_000 ? text : `${text.slice(0, 23_999)}…` }], details: value && typeof value === "object" ? value as Record<string, unknown> : { value } };
}

function toolError(code: string) {
	return { content: [{ type: "text" as const, text: code }], details: { code }, isError: true as const };
}

function routeFailure(error: unknown): string {
	const code = error instanceof Error ? error.message : "";
	return /^[A-Z][A-Z0-9_]{2,199}$/.test(code) ? code : "HINDSIGHT_ROUTE_UNAVAILABLE";
}

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "hindsight_recall", label: "Hindsight Recall", description: "Recall memories in the current project scope; all-project scope requires its separate grant.",
		parameters: Type.Object({ query: Type.String(), scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("all")])) }),
		async execute(_id, params: { query?: unknown; scope?: unknown }, signal) {
			const query = bounded(params.query, MAX_QUERY);
			if (!query) return toolError("QUERY_REQUIRED");
			if (params.scope !== undefined && params.scope !== "project" && params.scope !== "all") return toolError("SCOPE_INVALID");
			try { return toolResult(await callRoute("hindsight_recall", "recall", { query, ...(params.scope ? { scope: params.scope } : {}) }, signal)); }
			catch (error) { return toolError(routeFailure(error)); }
		},
	});

	pi.registerTool({
		name: "hindsight_retain", label: "Hindsight Retain", description: "Retain a durable memory in the current project scope. Requires the memory.write grant.",
		parameters: Type.Object({ content: Type.String(), kind: Type.Optional(Type.String()) }),
		async execute(_id, params: { content?: unknown; kind?: unknown }, signal) {
			const content = bounded(params.content, MAX_CONTENT);
			const kind = bounded(params.kind, 64);
			if (!content) return toolError("CONTENT_REQUIRED");
			try { return toolResult(await callRoute("hindsight_retain", "retain", { content, ...(kind ? { kind } : {}) }, signal)); }
			catch (error) { return toolError(routeFailure(error)); }
		},
	});

	pi.registerTool({
		name: "hindsight_reflect", label: "Hindsight Reflect", description: "Produce a scoped reflection from stored memories. Requires the memory.reflect grant.",
		parameters: Type.Object({ prompt: Type.String(), memoryIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })) }),
		async execute(_id, params: { prompt?: unknown; memoryIds?: unknown }, signal) {
			const prompt = bounded(params.prompt, MAX_QUERY);
			const memoryIds = Array.isArray(params.memoryIds) ? params.memoryIds.map(id => bounded(id, MAX_ID)).filter((id): id is string => !!id) : undefined;
			if (!prompt) return toolError("PROMPT_REQUIRED");
			if (Array.isArray(params.memoryIds) && memoryIds?.length !== params.memoryIds.length) return toolError("MEMORY_ID_INVALID");
			try { return toolResult(await callRoute("hindsight_reflect", "reflect", { prompt, ...(memoryIds?.length ? { memoryIds } : {}) }, signal)); }
			catch (error) { return toolError(routeFailure(error)); }
		},
	});

	pi.registerTool({
		name: "hindsight_invalidate", label: "Hindsight Invalidate", description: "Invalidate one selected memory after exact confirmation. Requires the memory.invalidate grant.",
		parameters: Type.Object({ id: Type.String(), confirmation: Type.String(), reason: Type.Optional(Type.String()) }),
		async execute(_id, params: { id?: unknown; confirmation?: unknown; reason?: unknown }, signal) {
			const id = bounded(params.id, MAX_ID);
			const confirmation = bounded(params.confirmation, MAX_ID);
			const reason = bounded(params.reason, 1_000);
			if (!id || !confirmation || confirmation !== id) return toolError("INVALIDATION_CONFIRMATION_REQUIRED");
			try { return toolResult(await callRoute("hindsight_invalidate", "invalidate", { id, confirmation, ...(reason ? { reason } : {}) }, signal)); }
			catch (error) { return toolError(routeFailure(error)); }
		},
	});

	pi.registerTool({
		name: "hindsight_retain_outcome", label: "Hindsight Retain Outcome", description: "Retain the host-supplied completed outcome when available. Requires the memory.write grant.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try { return toolResult(await callRoute("hindsight_retain_outcome", "retain-outcome", {}, signal)); }
			catch (error) { return toolError(routeFailure(error)); }
		},
	});
};

export default extension;

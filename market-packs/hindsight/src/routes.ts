// Hindsight pack SERVER routes. Project-scoped generic extension settings own
// configuration and secret writes. These routes retain only read-only legacy
// fallback diagnostics plus the durable queue diagnostics; they never write or
// return a legacy configuration value.

import {
	clientConfig,
	isConfigured,
	loadLegacyConfigForDiagnostics,
	loadQueue,
	makeClient,
	readStore,
	LAST_ERROR_KEY,
	type StoreLike,
	type StoreReadDiagnostic,
} from "./shared.js";

export { __setClientFactory } from "./shared.js";

interface RouteCtx {
	host: { store: StoreLike };
	sessionId?: string;
	projectId?: string;
}
interface RouteReq {
	method?: string;
}

/** Keep externally visible durable-store diagnostics stable, useful, and free of
 * implementation details (including paths, original error messages, and secrets). */
function safeDiagnostic(diagnostic: StoreReadDiagnostic): StoreReadDiagnostic {
	return {
		code: diagnostic.code,
		...(diagnostic.retryable === true ? { retryable: true } : {}),
		...(diagnostic.recoverable === true ? { recoverable: true } : {}),
	};
}

function projectSettings(ctx: RouteCtx) {
	return {
		scope: "project" as const,
		...(ctx.projectId ? { projectId: ctx.projectId } : {}),
		message: "Configure Hindsight in Market project settings.",
	};
}

function settingsRequired(ctx: RouteCtx) {
	return {
		configured: false,
		error: "HINDSIGHT_PROJECT_SETTINGS_REQUIRED",
		settings: projectSettings(ctx),
	};
}

async function queueStatus(store: StoreLike): Promise<{ queueDepth: number | null; queueState: "available" | "unavailable"; queueError?: StoreReadDiagnostic }> {
	const result = await loadQueue(store);
	return result.loaded
		? { queueDepth: result.queue.length, queueState: "available" }
		: { queueDepth: null, queueState: "unavailable", queueError: safeDiagnostic(result.diagnostic) };
}

/** Do not expose a stored error message. An upstream or transport error can carry
 * untrusted text, while the boolean is sufficient for the legacy status signal. */
async function lastErrorStatus(store: StoreLike): Promise<{ recorded?: true; unavailable?: StoreReadDiagnostic }> {
	const result = await readStore<unknown>(store, LAST_ERROR_KEY);
	if (result.state === "present") return { recorded: true };
	if (result.state === "error") return { unavailable: safeDiagnostic(result.diagnostic) };
	return {};
}

export const routes = {
	/**
	 * Compatibility endpoint for old pack clients. It intentionally has no write
	 * path: configuring a project, including any secret, is only possible through
	 * the gateway-owned extension-settings API. The legacy PackStore is inspected
	 * only to explain whether an old fallback exists, never to return its values.
	 */
	config: async (ctx: RouteCtx, req: RouteReq) => {
		const method = (req?.method ?? "GET").toUpperCase();
		if (method !== "GET") return { ok: false, ...settingsRequired(ctx) };

		const legacy = await loadLegacyConfigForDiagnostics(ctx.host.store);
		return legacy.available
			? {
				ok: true,
				deprecated: true,
				settings: projectSettings(ctx),
				legacyFallback: { state: "available" as const, configured: isConfigured(legacy.config) },
			}
			: {
				ok: true,
				deprecated: true,
				settings: projectSettings(ctx),
				legacyFallback: { state: "unavailable" as const, diagnostic: safeDiagnostic(legacy.diagnostic) },
			};
	},

	/** Read-only migration diagnostics. Current project configuration is purposely
	 * not read here: runtime receives it from the resolver as `ctx.config`. */
	status: async (ctx: RouteCtx) => {
		const store = ctx.host.store;
		const [legacy, queue, error] = await Promise.all([
			loadLegacyConfigForDiagnostics(store),
			queueStatus(store),
			lastErrorStatus(store),
		]);
		const base = {
			settings: projectSettings(ctx),
			...queue,
			...(error.recorded ? { lastErrorRecorded: true } : {}),
			...(error.unavailable ? { lastErrorUnavailable: error.unavailable } : {}),
		};
		if (!legacy.available) {
			return {
				...base,
				healthy: null,
				legacyFallback: { state: "unavailable" as const, diagnostic: safeDiagnostic(legacy.diagnostic) },
			};
		}
		const configured = isConfigured(legacy.config);
		if (!configured) {
			return {
				...base,
				healthy: null,
				legacyFallback: { state: "available" as const, configured: false },
			};
		}
		try {
			const client = await makeClient(clientConfig(legacy.config));
			return {
				...base,
				healthy: (await client.health()).ok === true,
				legacyFallback: { state: "available" as const, configured: true },
			};
		} catch {
			return {
				...base,
				healthy: false,
				legacyFallback: { state: "available" as const, configured: true },
			};
		}
	},

	// Project settings are not available to pack routes. Do not silently fall back
	// to global legacy credentials for manual operations: that would defeat project
	// isolation and create a competing configuration runtime.
	recall: async (ctx: RouteCtx, _req: RouteReq) => ({ ...settingsRequired(ctx), memories: [] }),
	retain: async (ctx: RouteCtx, _req: RouteReq) => ({ ok: false, ...settingsRequired(ctx) }),
	reflect: async (ctx: RouteCtx, _req: RouteReq) => ({ ...settingsRequired(ctx), text: "" }),
	banks: async (ctx: RouteCtx, _req: RouteReq) => ({ ...settingsRequired(ctx), banks: [] }),
};

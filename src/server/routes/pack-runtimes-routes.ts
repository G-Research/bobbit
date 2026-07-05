// src/server/routes/pack-runtimes-routes.ts
//
// STR-01 cohort 4: the `/api/pack-runtimes*` (P2 pack managed-runtime,
// Docker-backed supervisor) REST family — migrated out of handleApiRoute's
// legacy if/else chain into the core route registry
// (src/server/routes/route-table.ts). See docs/design/route-registry.md.
//
// Mechanical extraction — every handler body below is byte-for-byte the same
// logic as the block it replaced in server.ts, with the same mechanical
// substitutions cohort 1 established: `url.pathname.match(...)[1]` → the
// registry's named `:id` param; free variables that used to be
// handleApiRoute's own params/closures (json, jsonError, packRuntimeSupervisor,
// ...) destructured from `ctx`. `packContributionRegistry` and `readBodyText`
// are NEW `CoreRouteCtx` fields added by this cohort (see core-route-ctx.ts);
// `resolveRuntimeStartPlan`/`providerCarriesDeploymentMode` were already
// threaded through by cohort 3 (marketplace) in anticipation of this family.
// Zero behavior change: same auth (admin-bearer, gated before
// handleApiRoute), same validation, same status codes, same error shapes.
//
// LEGACY FALL-THROUGH PARITY (same subtlety cohort 2 hit): every one of the
// five sub-routes below matched the PATH first (a bare regex test with no
// upfront method gate) and only THEN checked `req.method`, answering a
// mismatched method with an immediate `405 "method not allowed"` — it never
// fell through past its own block for ANY method. A method-keyed registry
// can't reproduce "matched path, unhandled method → still terminate here"
// implicitly, so every non-supported method on each of these five path
// patterns is registered explicitly against `handleMethodNotAllowed`, which
// reproduces the exact 405 shape. Written as literal `register("METHOD", ...)`
// calls (not a loop) so tests/helpers/server-route-surface.ts's
// extractRegistryRoutes() sees the complete registered surface. Pinned by
// tests/pack-runtimes-route-parity.test.ts.
//
// The top-level `GET /api/pack-runtimes` route is DIFFERENT in shape — like
// cohort 1's routes, it gated on `url.pathname === ... && req.method === ...`
// together, so a mismatched method on that literal path always fell through
// to the rest of the (legacy, now core-registry-first) chain both before and
// after this migration; no parity shim is needed for it.

import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import {
	encodePackRuntimeId,
	decodePackRuntimeId,
	PackRuntimeNotFoundError,
	PackRuntimeBadRequestError,
	PackRuntimeDockerUnavailableError,
} from "../runtimes/index.js";
import { providerConfigStoreKey } from "../agent/pack-contributions.js";
import { getPackStore } from "../extension-host/pack-store.js";

// GET /api/pack-runtimes?projectId= → { runtimes: PackRuntimeStatus[] }
async function handlePackRuntimesList(ctx: CoreRouteCtx): Promise<void> {
	const { url, json, jsonError, packRuntimeSupervisor } = ctx;
	if (!packRuntimeSupervisor) { json({ error: "pack runtime supervisor unavailable" }, 503); return; }
	const projectId = url.searchParams.get("projectId") || undefined;
	try {
		const statuses = await packRuntimeSupervisor.list(projectId);
		// Re-derive the API id from {packId, runtimeId} so it always round-trips
		// through decodePackRuntimeId regardless of the supervisor's internal id.
		const runtimes = statuses.map((s) => ({ ...s, id: encodePackRuntimeId(s.packId, s.runtimeId) }));
		json({ runtimes });
	} catch (err) {
		jsonError(500, err);
	}
}

// GET /api/pack-runtimes/:id/capabilities?projectId=&mode= → capability summary.
//   Pre-start consent disclosure (P3 §8): images/services, host ports, the
//   managed data/volume path, the start policy, and the memory/trust copy. Pure
//   (no Docker), so the Market UI can render it BEFORE the user consents.
async function handlePackRuntimeCapabilities(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, jsonError, packRuntimeSupervisor, packContributionRegistry, providerCarriesDeploymentMode, mapDeploymentModeToRuntimeMode } = ctx;
	if (!packRuntimeSupervisor) { json({ error: "pack runtime supervisor unavailable" }, 503); return; }
	let packId: string, runtimeId: string;
	try { ({ packId, runtimeId } = decodePackRuntimeId(params.id)); }
	catch (err) { if (err instanceof PackRuntimeBadRequestError) { jsonError(400, err); return; } jsonError(500, err); return; }
	const projectId = url.searchParams.get("projectId") || undefined;
	const rawMode = url.searchParams.get("mode");
	const requestedMode = rawMode !== null && rawMode.trim().length > 0 ? rawMode.trim() : undefined;
	// The disclosure is DEPLOYMENT-mode aware (external / managed / managed-external-
	// postgres). The caller may pass an explicit mode; absent that, resolve the
	// EFFECTIVE deployment mode from the pack's provider config so the external
	// (no-Docker) setup path is reachable even when the UI does not know the mode.
	// Build the EFFECTIVE deployment config the SAME way the activation path does
	// (each provider's flat schema defaults overlaid with its persisted store
	// config), so the consent disclosure reflects custom settings — most importantly
	// a custom `dataDir` bind path — rather than schema defaults that would diverge
	// from what activation actually mounts.
	const deploymentConfig: Record<string, unknown> = {};
	let hasDeploymentSurface = false;
	let runtimeManifest: Record<string, unknown> | undefined;
	{
		// Read RAW (activation-UNFILTERED) contributions, NOT `getPack` — the latter
		// drops a provider whose activation gate is still unsatisfied (e.g. Hindsight's
		// external-mode `memory` provider before `externalUrl` is set), which would
		// misclassify fresh/default Hindsight as provider-less and disclose the Docker
		// default mode instead of the external (no-Docker) setup path.
		const pack = packContributionRegistry.getRawPack(projectId, packId);
		runtimeManifest = pack?.runtimes.find((r) => r.id === runtimeId)?.manifest;
		for (const p of pack?.providers ?? []) {
			const merged: Record<string, unknown> = { ...(p.config ?? {}) };
			const persisted = getPackStore().getSync<Record<string, unknown>>(packId, providerConfigStoreKey(p.id));
			if (persisted && typeof persisted === "object") Object.assign(merged, persisted);
			Object.assign(deploymentConfig, merged);
			if (providerCarriesDeploymentMode(p, merged)) hasDeploymentSurface = true;
		}
	}
	// Resolve the EFFECTIVE deployment mode. With NO deployment surface (a provider-
	// less runtime pack, or a pack whose only provider carries no deployment mode)
	// there is no external/managed concept to honour, so the disclosure must show the
	// runtime's manifest DEFAULT (Docker) mode/services/ports — the SAME no-surface
	// fallback the activation/start paths use (they start such runtimes in the
	// manifest default mode). Only fall back to `external` when a deployment surface
	// exists but selects no managed mode.
	const deploymentMode = requestedMode
		?? (typeof deploymentConfig.mode === "string" && deploymentConfig.mode.length > 0
			? deploymentConfig.mode
			: (hasDeploymentSurface ? "external" : undefined));
	// Deployment mode → runtime manifest mode, read DECLARATIVELY from the
	// runtime's own manifest (`deploymentModes` — see
	// src/server/runtime/manifest.ts and resolveRuntimeStartPlan's doc comment
	// in server.ts). `external` is the non-Docker setup path.
	try {
		if (deploymentMode === undefined) {
			// No deployment surface: disclose the runtime's manifest DEFAULT (Docker)
			// mode/services/ports (capabilitySummary with no mode picks the first
			// manifest mode). dockerRequired:true mirrors the start path bringing this
			// runtime up in its default mode.
			const summary = await packRuntimeSupervisor.capabilitySummary(packId, runtimeId, { projectId, config: deploymentConfig });
			json({ ...summary, id: encodePackRuntimeId(summary.packId, summary.runtimeId), dockerRequired: true });
			return;
		}
		if (deploymentMode === "external") {
			// External: derive descriptor/trust from the default manifest mode but disclose
			// NO services/ports and flag dockerRequired:false, so the UI shows setup
			// guidance instead of a Docker start disclosure. Works without Docker.
			const base = await packRuntimeSupervisor.capabilitySummary(packId, runtimeId, { projectId });
			json({ ...base, id: encodePackRuntimeId(base.packId, base.runtimeId), mode: "external", services: [], images: [], ports: [], volumePath: undefined, dockerRequired: false });
			return;
		}
		const runtimeMode = mapDeploymentModeToRuntimeMode(deploymentMode, runtimeManifest);
		const summary = await packRuntimeSupervisor.capabilitySummary(packId, runtimeId, { projectId, mode: runtimeMode, config: deploymentConfig });
		json({ ...summary, id: encodePackRuntimeId(summary.packId, summary.runtimeId), dockerRequired: true });
	} catch (err) {
		if (err instanceof PackRuntimeNotFoundError) { jsonError(404, err); return; }
		if (err instanceof PackRuntimeBadRequestError) { jsonError(400, err); return; }
		jsonError(500, err);
	}
}

// POST /api/pack-runtimes/:id/down { volumes?: boolean, removeState?: boolean }
//   `docker compose down`. Default (no volumes/removeState) preserves bind-mounted
//   data — the uninstall primitive. `volumes: true` + `removeState: true` is the
//   explicit purge.
async function handlePackRuntimeDown(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { req, url, json, jsonError, packRuntimeSupervisor, readBodyText } = ctx;
	if (!packRuntimeSupervisor) { json({ error: "pack runtime supervisor unavailable" }, 503); return; }
	let packId: string, runtimeId: string;
	try { ({ packId, runtimeId } = decodePackRuntimeId(params.id)); }
	catch (err) { if (err instanceof PackRuntimeBadRequestError) { jsonError(400, err); return; } jsonError(500, err); return; }
	const projectId = url.searchParams.get("projectId") || undefined;
	const bodyText = await readBodyText(req);
	if (bodyText === null) { json({ error: "request body unreadable or too large" }, 400); return; }
	let body: Record<string, unknown> = {};
	const trimmed = bodyText.trim();
	if (trimmed.length > 0) {
		let parsed: unknown;
		try { parsed = JSON.parse(trimmed); } catch { json({ error: "malformed JSON body" }, 400); return; }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { json({ error: "malformed JSON body" }, 400); return; }
		body = parsed as Record<string, unknown>;
	}
	const volumes = body.volumes === true;
	const removeState = body.removeState === true;
	try {
		const status = await packRuntimeSupervisor.down(packId, runtimeId, { projectId, volumes, removeState });
		json({ ...status, id: encodePackRuntimeId(status.packId, status.runtimeId) });
	} catch (err) {
		if (err instanceof PackRuntimeNotFoundError) { jsonError(404, err); return; }
		if (err instanceof PackRuntimeBadRequestError) { jsonError(400, err); return; }
		jsonError(500, err);
	}
}

// Shared body for POST /api/pack-runtimes/:id/{start,stop,restart} and
// GET /api/pack-runtimes/:id/logs — the legacy code matched all four actions
// with one regex capturing the action name; the registry instead registers
// one literal pattern per action (RouteTable has no in-segment alternation),
// each pointing at this same handler with `action` passed explicitly.
async function handlePackRuntimeAction(
	ctx: CoreRouteCtx,
	params: Record<string, string>,
	action: "start" | "stop" | "restart" | "logs",
): Promise<void> {
	const {
		req, url, json, jsonError, packRuntimeSupervisor, readBodyText,
		packContributionRegistry, providerCarriesDeploymentMode, resolveRuntimeStartPlan,
	} = ctx;
	if (!packRuntimeSupervisor) { json({ error: "pack runtime supervisor unavailable" }, 503); return; }

	// Map supervisor failures to status codes: NotFound → 404, BadRequest → 400.
	const handleErr = (err: unknown): void => {
		if (err instanceof PackRuntimeNotFoundError) { jsonError(404, err); return; }
		if (err instanceof PackRuntimeBadRequestError) { jsonError(400, err); return; }
		jsonError(500, err);
	};

	// Decode the URL-safe id (raw path segment — decodePackRuntimeId percent-
	// decodes the halves itself). Malformed → PackRuntimeBadRequestError → 400.
	let packId: string;
	let runtimeId: string;
	try {
		({ packId, runtimeId } = decodePackRuntimeId(params.id));
	} catch (err) { handleErr(err); return; }
	const projectId = url.searchParams.get("projectId") || undefined;

	if (action === "logs") {
		// Tail validation/clamping is owned by the supervisor (clampTail): a
		// non-numeric tail throws PackRuntimeBadRequestError → 400; out-of-range
		// values are clamped. Pass the raw query value through.
		const rawTail = url.searchParams.get("tail");
		const tail = rawTail !== null && rawTail !== "" ? (Number(rawTail) as number) : undefined;
		try {
			const logs = await packRuntimeSupervisor.logs(packId, runtimeId, { projectId, tail });
			json({ logs });
		} catch (err) {
			// Surface a missing-Docker install as a consistent docker-unavailable
			// shape (200 with empty logs + status) rather than hiding it behind an
			// empty body or a generic 500.
			if (err instanceof PackRuntimeDockerUnavailableError) {
				json({ logs: "", status: "docker-unavailable", message: err.message });
				return;
			}
			handleErr(err);
		}
		return;
	}

	// start | stop | restart — optional `mode` from the POST body. An EMPTY body
	// is valid (default mode); a NON-EMPTY but malformed-JSON body is a client
	// error — answer 400 and do NOT invoke the supervisor (never silently treat
	// garbage as `{}` and mutate the default mode).
	const bodyText = await readBodyText(req);
	if (bodyText === null) { json({ error: "request body unreadable or too large" }, 400); return; }
	let body: Record<string, unknown> = {};
	const trimmedBody = bodyText.trim();
	if (trimmedBody.length > 0) {
		let parsed: unknown;
		try { parsed = JSON.parse(trimmedBody); } catch { json({ error: "malformed JSON body" }, 400); return; }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { json({ error: "malformed JSON body" }, 400); return; }
		body = parsed as Record<string, unknown>;
	}
	let mode: string | undefined;
	let explicitMode = false;
	let startConfig: Record<string, unknown> | undefined;
	if (action !== "stop") {
		const rawMode = (body as { mode?: unknown }).mode;
		if (rawMode !== undefined && rawMode !== null) {
			if (typeof rawMode !== "string" || rawMode.trim().length === 0) { json({ error: "malformed mode" }, 400); return; }
			mode = rawMode;
			explicitMode = true;
		}
		// Derive the saved provider deployment config and remap it onto the
		// runtime's env keys EXACTLY like marketplace activation start does
		// (resolveRuntimeStartPlan — the shared source of truth). Without this the
		// route would forward only {projectId, mode} and a managed start would fail
		// to resolve HINDSIGHT_API_LLM_API_KEY / HINDSIGHT_API_DATABASE_URL.
		const deploymentConfig: Record<string, unknown> = {};
		let hasDeploymentSurface = false;
		let runtimeManifest: Record<string, unknown> | undefined;
		{
			// Read RAW (activation-UNFILTERED) contributions — see the /capabilities route
			// above for why getRawPack (not getPack) is required here.
			const pack = packContributionRegistry.getRawPack(projectId, packId);
			runtimeManifest = pack?.runtimes.find((r) => r.id === runtimeId)?.manifest;
			for (const p of pack?.providers ?? []) {
				const merged: Record<string, unknown> = { ...(p.config ?? {}) };
				const persisted = getPackStore().getSync<Record<string, unknown>>(packId, providerConfigStoreKey(p.id));
				if (persisted && typeof persisted === "object") Object.assign(merged, persisted);
				Object.assign(deploymentConfig, merged);
				// A deployment surface requires a provider that ACTUALLY carries a
				// deployment mode — an unrelated provider (no mode) must behave like a
				// provider-less runtime so the no-surface fallback below applies.
				if (providerCarriesDeploymentMode(p, merged)) hasDeploymentSurface = true;
			}
		}
		// Declarative plan (S1): the target runtime's OWN manifest carries the
		// `deploymentModes`/`configRemap` policy — see resolveRuntimeStartPlan's
		// doc comment in server.ts and src/server/runtime/manifest.ts.
		const plan = resolveRuntimeStartPlan(deploymentConfig, runtimeManifest);
		startConfig = plan.config;
		// Respect a saved EXTERNAL (or default/unset) deployment mode: that is the
		// non-Docker setup path (plan.start === false), so there is NO managed
		// runtime to bring up. Without an explicit body mode the route must NOT
		// silently fall through to the runtime's first manifest mode (managed) and
		// start Docker — activation already gates on plan.start, and the REST surface
		// must agree. Answer 409 with a clear external/no-runtime shape; a caller that
		// genuinely wants to start a managed stack must pass an explicit `mode`.
		//
		// The guard applies ONLY when the pack actually exposes a deployment-config
		// surface (a provider whose config carries the mode). A runtime with no such
		// surface has no external/managed concept to honor, so it keeps the legacy
		// supervisor-default-mode behaviour and an unknown pack still reaches the
		// supervisor (→ 404) rather than being masked by this 409.
		if (hasDeploymentSurface && !plan.start && !explicitMode) {
			const deploymentMode = typeof deploymentConfig.mode === "string" && deploymentConfig.mode.length > 0
				? deploymentConfig.mode
				: "external";
			json({
				error: "runtime is configured for external (non-managed) mode; no Docker runtime to start",
				mode: deploymentMode,
				status: "stopped",
				started: false,
				id: encodePackRuntimeId(packId, runtimeId),
			}, 409);
			return;
		}
		// An explicit body mode (a runtime manifest mode) overrides the
		// deployment-derived plan mode; otherwise use the plan's mapped mode.
		if (mode === undefined) mode = plan.mode;
	}
	try {
		const status = action === "stop"
			? await packRuntimeSupervisor.stop(packId, runtimeId, { projectId })
			: action === "start"
				? await packRuntimeSupervisor.start(packId, runtimeId, { projectId, mode, config: startConfig })
				: await packRuntimeSupervisor.restart(packId, runtimeId, { projectId, mode, config: startConfig });
		json({ ...status, id: encodePackRuntimeId(status.packId, status.runtimeId) });
	} catch (err) { handleErr(err); }
}

function handlePackRuntimeStart(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	return handlePackRuntimeAction(ctx, params, "start");
}
function handlePackRuntimeStop(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	return handlePackRuntimeAction(ctx, params, "stop");
}
function handlePackRuntimeRestart(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	return handlePackRuntimeAction(ctx, params, "restart");
}
function handlePackRuntimeLogs(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	return handlePackRuntimeAction(ctx, params, "logs");
}

// See the LEGACY FALL-THROUGH PARITY note in the module header: every
// non-supported method on the five path patterns below terminated inside the
// legacy block with this exact 405, never falling further down the chain.
function handleMethodNotAllowed(ctx: CoreRouteCtx): void {
	ctx.json({ error: "method not allowed" }, 405);
}

export function registerPackRuntimesRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/pack-runtimes", handlePackRuntimesList);

	table.register("GET", "/api/pack-runtimes/:id/capabilities", handlePackRuntimeCapabilities);
	table.register("POST", "/api/pack-runtimes/:id/capabilities", handleMethodNotAllowed);
	table.register("PUT", "/api/pack-runtimes/:id/capabilities", handleMethodNotAllowed);
	table.register("PATCH", "/api/pack-runtimes/:id/capabilities", handleMethodNotAllowed);
	table.register("DELETE", "/api/pack-runtimes/:id/capabilities", handleMethodNotAllowed);

	table.register("POST", "/api/pack-runtimes/:id/down", handlePackRuntimeDown);
	table.register("GET", "/api/pack-runtimes/:id/down", handleMethodNotAllowed);
	table.register("PUT", "/api/pack-runtimes/:id/down", handleMethodNotAllowed);
	table.register("PATCH", "/api/pack-runtimes/:id/down", handleMethodNotAllowed);
	table.register("DELETE", "/api/pack-runtimes/:id/down", handleMethodNotAllowed);

	table.register("POST", "/api/pack-runtimes/:id/start", handlePackRuntimeStart);
	table.register("GET", "/api/pack-runtimes/:id/start", handleMethodNotAllowed);
	table.register("PUT", "/api/pack-runtimes/:id/start", handleMethodNotAllowed);
	table.register("PATCH", "/api/pack-runtimes/:id/start", handleMethodNotAllowed);
	table.register("DELETE", "/api/pack-runtimes/:id/start", handleMethodNotAllowed);

	table.register("POST", "/api/pack-runtimes/:id/stop", handlePackRuntimeStop);
	table.register("GET", "/api/pack-runtimes/:id/stop", handleMethodNotAllowed);
	table.register("PUT", "/api/pack-runtimes/:id/stop", handleMethodNotAllowed);
	table.register("PATCH", "/api/pack-runtimes/:id/stop", handleMethodNotAllowed);
	table.register("DELETE", "/api/pack-runtimes/:id/stop", handleMethodNotAllowed);

	table.register("POST", "/api/pack-runtimes/:id/restart", handlePackRuntimeRestart);
	table.register("GET", "/api/pack-runtimes/:id/restart", handleMethodNotAllowed);
	table.register("PUT", "/api/pack-runtimes/:id/restart", handleMethodNotAllowed);
	table.register("PATCH", "/api/pack-runtimes/:id/restart", handleMethodNotAllowed);
	table.register("DELETE", "/api/pack-runtimes/:id/restart", handleMethodNotAllowed);

	table.register("GET", "/api/pack-runtimes/:id/logs", handlePackRuntimeLogs);
	table.register("POST", "/api/pack-runtimes/:id/logs", handleMethodNotAllowed);
	table.register("PUT", "/api/pack-runtimes/:id/logs", handleMethodNotAllowed);
	table.register("PATCH", "/api/pack-runtimes/:id/logs", handleMethodNotAllowed);
	table.register("DELETE", "/api/pack-runtimes/:id/logs", handleMethodNotAllowed);
}

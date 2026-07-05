// src/server/routes/server-system-routes.ts
//
// STR-01 cohort 9: early server/system status routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// LEGACY FALL-THROUGH PARITY: no 405 shim needed. Every legacy block in this
// family gated on path and method in the same `if` condition, so method
// mismatches fell through to the terminal 404. RouteTable's method-scoped
// matching preserves that by leaving other methods unregistered.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitConfigDir, bobbitStateDir } from "../bobbit-dir.js";
import { detectHostTokens } from "../agent/host-tokens.js";
import { resolveProjectForRequest } from "../agent/resolve-project.js";
import {
	buildSandboxImage,
	checkDockerAvailability,
	isBuildingImage,
	resolveSandboxDockerContext,
} from "../agent/sandbox-status.js";
import { BOOT_TIMING_FILE, readBootTimings, recordBootTiming } from "../dev-boot-timing.js";
import { touchGatewayRestartSentinel } from "../harness-signal.js";
import { paceAndSend, PACE_TIMEOUT_MS } from "../replay-pacing.js";
import { isSetupComplete } from "../setup-status.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/harness-status — report whether the dev restart harness is active
async function handleHarnessStatus(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	json({ restartAvailable: process.env.BOBBIT_DEV_HARNESS === "1" });
}

// POST /api/harness/restart — request a dev harness rebuild/restart
async function handleHarnessRestart(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	if (process.env.BOBBIT_DEV_HARNESS !== "1") {
		json({ error: "Restart is only available under the dev harness" }, 403);
		return;
	}
	touchGatewayRestartSentinel();
	json({ ok: true, restartRequested: true }, 202);
}

// POST /api/dev/boot-timing — append one client reload-timing sample.
async function handleBootTimingPost(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	if (process.env.BOBBIT_DEV_HARNESS !== "1") {
		json({ error: "Perf instrumentation is only available under the dev harness" }, 403);
		return;
	}
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
	const written = recordBootTiming(body);
	if (!written) { json({ error: "Sample rejected" }, 422); return; }
	json({ ok: true, path: path.join(bobbitStateDir(), BOOT_TIMING_FILE) }, 201);
}

// GET /api/dev/boot-timing — read recent reload-timing samples.
async function handleBootTimingGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, url } = ctx;
	if (process.env.BOBBIT_DEV_HARNESS !== "1") {
		json({ error: "Perf instrumentation is only available under the dev harness" }, 403);
		return;
	}
	const limitParamRaw = url.searchParams.get("limit");
	const limit = limitParamRaw ? Math.max(1, Math.min(500, parseInt(limitParamRaw, 10) || 50)) : 50;
	json({ path: path.join(bobbitStateDir(), BOOT_TIMING_FILE), samples: readBootTimings(limit) });
}

// GET /api/health — unauthenticated so the client can probe localhost mode.
async function handleHealth(ctx: CoreRouteCtx): Promise<void> {
	const { json, config, getAigwUrl, sessionManager, preferencesStore } = ctx;
	const isLocalhost = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");
	json({
		status: "ok",
		sessions: sessionManager.listSessions().length,
		localhost: isLocalhost,
		aigw: !!getAigwUrl(preferencesStore),
		setupComplete: isSetupComplete(),
		orphanedTranscripts: sessionManager.orphanedTranscriptsCount,
		sessionStoreStaleRecovery: sessionManager.getStaleSessionStoreStatus(),
	});
}

// POST /api/internal/test/replay-buffered-events/:sessionId — BOBBIT_E2E-only hook.
async function handleReplayBufferedEvents(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager } = ctx;
	if (process.env.BOBBIT_E2E !== "1") { json({ error: "BOBBIT_E2E not enabled" }, 403); return; }
	const sessionId = params.sessionId;
	const session = sessionManager.getSession(sessionId);
	if (!session) { json({ error: "session not found" }, 404); return; }
	const entries = session.eventBuffer.getAll() as any[];
	let replayed = 0;
	const deadline = Date.now() + PACE_TIMEOUT_MS;
	for (const entry of entries) {
		const isWrapped = entry && typeof entry === "object" && "event" in entry && ("seq" in entry || "ts" in entry);
		const framePayload = isWrapped
			? { type: "event" as const, data: entry.event, seq: entry.seq, ts: entry.ts }
			: { type: "event" as const, data: entry };
		const data = JSON.stringify(framePayload);
		for (const client of session.clients) {
			await paceAndSend(client as any, data, deadline);
		}
		replayed++;
	}
	json({ replayed, bufferSize: session.eventBuffer.size });
}

// GET /api/setup-status — check if project setup has been completed
async function handleSetupStatus(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	json({ complete: isSetupComplete() });
}

// POST /api/setup-status/dismiss — mark setup as dismissed.
async function handleSetupStatusDismiss(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	const stateDir = bobbitStateDir();
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(stateDir, "setup-complete"), "dismissed\n");
	json({ ok: true });
}

// GET /api/system-prompt-context — read the project context section.
async function handleSystemPromptContextGet(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
	if (!fs.existsSync(systemPromptPath)) { json({ context: "" }); return; }
	try {
		const content = fs.readFileSync(systemPromptPath, "utf-8");
		const marker = "# Project Context";
		const idx = content.lastIndexOf(marker);
		if (idx === -1) { json({ context: "" }); return; }
		const context = content.slice(idx + marker.length).trim();
		json({ context });
	} catch { json({ context: "" }); }
}

// PUT /api/system-prompt-context — append/replace the project context section.
async function handleSystemPromptContextPut(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body || typeof body.context !== "string") { json({ error: "Missing context" }, 400); return; }
	const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
	try {
		let existing = "";
		if (fs.existsSync(systemPromptPath)) {
			existing = fs.readFileSync(systemPromptPath, "utf-8");
		}
		const marker = "# Project Context";
		const idx = existing.lastIndexOf(marker);
		const base = idx !== -1 ? existing.slice(0, idx).trimEnd() : existing.trimEnd();
		const newContent = base + "\n\n" + marker + "\n\n" + body.context.trim() + "\n";
		fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
		fs.writeFileSync(systemPromptPath, newContent);
		json({ ok: true });
	} catch (err: any) {
		jsonError(500, err);
	}
}

// POST /api/system-prompt/customise — copy shipped default to .bobbit/config/system-prompt.md.
async function handleSystemPromptCustomise(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError } = ctx;
	const userPath = path.join(bobbitConfigDir(), "system-prompt.md");
	const routeDir = path.dirname(fileURLToPath(import.meta.url));
	const defaultPathCandidates = [
		path.join(routeDir, "..", "defaults", "system-prompt.md"),
		path.join(routeDir, "..", "..", "..", "defaults", "system-prompt.md"),
	];
	const defaultPath = defaultPathCandidates.find(p => fs.existsSync(p)) ?? defaultPathCandidates[0];
	let created = false;
	try {
		if (!fs.existsSync(userPath)) {
			if (!fs.existsSync(defaultPath)) {
				json({ error: "Default system-prompt.md not found in install" }, 500);
				return;
			}
			fs.mkdirSync(path.dirname(userPath), { recursive: true });
			fs.copyFileSync(defaultPath, userPath);
			created = true;
		}
		const content = fs.readFileSync(userPath, "utf-8");
		json({ path: userPath, created, content });
	} catch (err: any) {
		jsonError(500, err);
	}
}

// POST /api/shutdown — graceful shutdown (used by coverage teardown to flush V8 coverage).
async function handleShutdown(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	json({ status: "shutting down" });
	setTimeout(() => process.exit(0), 500);
}

// GET /api/ca-cert — download the Bobbit CA certificate for device trust.
async function handleCaCert(ctx: CoreRouteCtx): Promise<void> {
	const { config, json, res } = ctx;
	const caCertPath = config.tls?.caCert;
	if (!caCertPath || !fs.existsSync(caCertPath)) {
		json({ error: "No CA certificate available. Server is using a self-signed certificate." }, 404);
		return;
	}
	const certData = fs.readFileSync(caCertPath);
	res.writeHead(200, {
		// iOS Safari needs this MIME type to offer the profile-install flow.
		"Content-Type": "application/x-x509-ca-cert",
		"Content-Disposition": "attachment; filename=\"bobbit-ca.crt\"",
		"Content-Length": certData.length,
	});
	res.end(certData);
}

// GET /api/sandbox-pool (deprecated — no longer a real pool, returns basic stats)
async function handleSandboxPool(ctx: CoreRouteCtx): Promise<void> {
	const { json, sandboxManager } = ctx;
	if (sandboxManager) {
		const stats = sandboxManager.getStats();
		json({ ...stats, type: "sandbox" });
	} else {
		json({ enabled: false });
	}
}

// GET /api/worktree-pool
async function handleWorktreePool(ctx: CoreRouteCtx): Promise<void> {
	const { json, sessionManager, url } = ctx;
	const projectId = url.searchParams.get("projectId");
	if (projectId) {
		const pool = sessionManager.getWorktreePool(projectId);
		json(pool ? pool.getStatus() : { enabled: false, ready: 0, target: 0, filling: false });
	} else {
		const pools: Record<string, any> = {};
		for (const [pid, pool] of sessionManager.getAllWorktreePools()) {
			pools[pid] = pool.getStatus();
		}
		json({ pools });
	}
}

// GET /api/sandbox-status
async function handleSandboxStatus(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectRegistry, resolveProjectConfigStore, url, writeProjectResolutionError } = ctx;
	const projectId = url.searchParams.get("projectId") || undefined;
	const resolved = resolveProjectForRequest(projectRegistry, { projectId });
	if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
	const scopedConfigStore = resolveProjectConfigStore(resolved.projectId);
	const sandboxConfig = scopedConfigStore.get("sandbox") || "none";
	const imageName = scopedConfigStore.get("sandbox_image") || "bobbit-agent";
	const configured = sandboxConfig === "docker";
	const dockerContextRoot = resolveSandboxDockerContext(resolved.project.rootPath);
	const status = await checkDockerAvailability(configured ? imageName : undefined, dockerContextRoot ?? undefined);
	json({ ...status, configured });
}

// POST /api/sandbox-image/build
async function handleSandboxImageBuild(ctx: CoreRouteCtx): Promise<void> {
	const { json, projectRegistry, readBody, req, resolveProjectConfigStore, url, writeProjectResolutionError } = ctx;
	const body = await readBody(req).catch(() => null);
	const projectId = (body && typeof body === "object" && typeof (body as any).projectId === "string")
		? (body as any).projectId
		: url.searchParams.get("projectId") || undefined;
	const resolved = resolveProjectForRequest(projectRegistry, { projectId });
	if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
	const scopedConfigStore = resolveProjectConfigStore(resolved.projectId);
	const imageName = scopedConfigStore.get("sandbox_image") || "bobbit-agent";
	const dockerContextRoot = resolveSandboxDockerContext(resolved.project.rootPath);
	if (!dockerContextRoot) {
		json({ error: "Dockerfile not found at docker/Dockerfile" }, 404);
		return;
	}
	if (isBuildingImage()) {
		json({ error: "Build already in progress" }, 409);
		return;
	}
	const result = await buildSandboxImage(imageName, dockerContextRoot);
	if (result.success) {
		json({ success: true });
	} else {
		json({ success: false, error: result.error }, 500);
	}
}

// GET /api/sandbox/host-tokens
async function handleSandboxHostTokens(ctx: CoreRouteCtx): Promise<void> {
	const { json, preferencesStore } = ctx;
	const tokens = detectHostTokens(preferencesStore);
	json(tokens);
}

export function registerServerSystemRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/harness-status", handleHarnessStatus);
	table.register("POST", "/api/harness/restart", handleHarnessRestart);
	table.register("POST", "/api/dev/boot-timing", handleBootTimingPost);
	table.register("GET", "/api/dev/boot-timing", handleBootTimingGet);
	table.register("GET", "/api/health", handleHealth);
	table.register("POST", "/api/internal/test/replay-buffered-events/:sessionId", handleReplayBufferedEvents);
	table.register("GET", "/api/setup-status", handleSetupStatus);
	table.register("POST", "/api/setup-status/dismiss", handleSetupStatusDismiss);
	table.register("GET", "/api/system-prompt-context", handleSystemPromptContextGet);
	table.register("PUT", "/api/system-prompt-context", handleSystemPromptContextPut);
	table.register("POST", "/api/system-prompt/customise", handleSystemPromptCustomise);
	table.register("POST", "/api/shutdown", handleShutdown);
	table.register("GET", "/api/ca-cert", handleCaCert);
	table.register("GET", "/api/sandbox-pool", handleSandboxPool);
	table.register("GET", "/api/worktree-pool", handleWorktreePool);
	table.register("GET", "/api/sandbox-status", handleSandboxStatus);
	table.register("POST", "/api/sandbox-image/build", handleSandboxImageBuild);
	table.register("GET", "/api/sandbox/host-tokens", handleSandboxHostTokens);
}

// src/server/routes/preferences-routes.ts
//
// STR-01 cohort 12: Preferences routes migrated out of handleApiRoute's
// legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { consumeOperatorConfirmation, mintOperatorConfirmation } from "../auth/operator-confirmation.js";
import { CLAUDE_CODE_OPERATOR_CONFIRMATION_PURPOSE, isClaudeCodePreferenceKey, normalizeClaudeCodePreferencePatch } from "../agent/claude-code-config.js";
import { invalidateClaudeCodeStatusCache } from "../agent/claude-code-status.js";
import { invalidateModelCache } from "../agent/model-registry.js";
import { normalizeTrustedHosts } from "../../shared/pr-walkthrough/url-safety.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// POST /api/preferences/claude-code/confirmation — mint a short-lived operator confirmation
// for host-local Claude Code preferences that affect process execution or permission bypass.
async function handleClaudeCodePreferenceConfirmation(ctx: CoreRouteCtx): Promise<void> {
	const { req, json, readBody, isHumanOperatorRequest, claudeCodeConfirmationBinding } = ctx;
	if (!isHumanOperatorRequest()) {
		json({ error: "Claude Code preference confirmation requires an operator browser session" }, 403);
		return;
	}
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
	let confirmation: { requiresConfirmation: boolean; keys: string[]; binding: string };
	try {
		confirmation = claudeCodeConfirmationBinding(body as Record<string, unknown>);
	} catch (err: any) {
		json({ error: err?.message || String(err) }, 400);
		return;
	}
	if (!confirmation.requiresConfirmation) {
		json({ confirmationRequired: false, sensitiveKeys: [] });
		return;
	}
	const minted = mintOperatorConfirmation({ purpose: CLAUDE_CODE_OPERATOR_CONFIRMATION_PURPOSE, binding: confirmation.binding });
	json({ confirmationRequired: true, confirmationToken: minted.token, expiresAt: minted.expiresAt, sensitiveKeys: confirmation.keys });
	return;
}

// GET /api/preferences — return all preferences (filter sensitive keys)
async function handlePreferencesGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, getSafePreferences } = ctx;
	json(getSafePreferences());
	return;
}

// PUT /api/preferences — merge preferences
async function handlePreferencesPut(ctx: CoreRouteCtx): Promise<void> {
	const {
		req, json, readBody, firstHeader, isHumanOperatorRequest,
		claudeCodeConfirmationBinding, preferencesStore, getSafePreferences,
		broadcastPreferencesChanged, broadcastToAll, listProjectsForApi,
	} = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
	const blockedAgentDirKeys = ["agentDir", "agentDirHistory"];
	const blockedKey = Object.keys(body).find(key => blockedAgentDirKeys.includes(key));
	if (blockedKey) {
		json({
			error: `${blockedKey} is managed by the agent directory settings workflow. Use PUT /api/agent-dir/pending instead.`,
			code: "AGENT_DIR_PREFERENCE_FORBIDDEN",
			key: blockedKey,
			use: "/api/agent-dir/pending",
		}, 400);
		return;
	}
	const claudeCodePrefsChanged = Object.keys(body).some(isClaudeCodePreferenceKey);
	let preferencePatch = body as Record<string, unknown>;
	if (claudeCodePrefsChanged) {
		let confirmation: { requiresConfirmation: boolean; keys: string[]; binding: string };
		try {
			confirmation = claudeCodeConfirmationBinding(preferencePatch);
		} catch (err: any) {
			json({ error: err?.message || String(err) }, 400);
			return;
		}
		if (confirmation.requiresConfirmation) {
			const token = firstHeader("x-bobbit-operator-confirmation");
			const confirmed = isHumanOperatorRequest()
				&& consumeOperatorConfirmation(token, { purpose: CLAUDE_CODE_OPERATOR_CONFIRMATION_PURPOSE, binding: confirmation.binding });
			if (!confirmed) {
				json({
					error: "Claude Code host-runtime preference changes require operator confirmation",
					confirmationRequired: true,
					sensitiveKeys: confirmation.keys,
				}, 403);
				return;
			}
		}
		const normalized = normalizeClaudeCodePreferencePatch(preferencePatch, preferencesStore);
		if (!normalized.ok) { json({ error: normalized.error }, 400); return; }
		preferencePatch = { ...preferencePatch, ...normalized.values };
	}
	const headquartersVisibilityChanged = Object.prototype.hasOwnProperty.call(body, "showHeadquartersInProjectLists");
	for (const [key, value] of Object.entries(preferencePatch)) {
		if (key === "githubTrustedHosts") {
			// Normalize-and-store the accepted subset (lossy, no 4xx). GET readback is
			// authoritative. An empty/invalid list removes the key entirely.
			const normalized = normalizeTrustedHosts(value);
			if (normalized.length === 0) preferencesStore.remove(key);
			else preferencesStore.set(key, normalized);
		} else if (value === null || value === undefined) {
			preferencesStore.remove(key);
		} else {
			preferencesStore.set(key, value);
		}
	}
	if (claudeCodePrefsChanged) {
		invalidateClaudeCodeStatusCache();
		invalidateModelCache();
	}
	json(getSafePreferences());
	broadcastPreferencesChanged();
	if (headquartersVisibilityChanged) {
		broadcastToAll({ type: "projects_changed", projects: listProjectsForApi() });
	}
	return;
}

export function registerPreferencesRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/preferences/claude-code/confirmation", handleClaudeCodePreferenceConfirmation);
	table.register("GET", "/api/preferences", handlePreferencesGet);
	table.register("PUT", "/api/preferences", handlePreferencesPut);
}

/**
 * Session model/thinking resolution — cohort 9 of the SessionManager
 * decomposition. SessionManager keeps same-named delegating wrappers so the
 * public and source-pinned call sites continue to route through the manager.
 */
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import type { SessionInfo } from "./session-manager.js";
import type { SessionStore } from "./session-store.js";
import type { Role } from "./role-store.js";
import type { RoleManager } from "./role-manager.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { ConfigCascade } from "./config-cascade.js";
import { applyModelString } from "./review-model-override.js";
import { sanitizeModelErrorForLog, sanitizeModelErrorText } from "./model-error-sanitizer.js";
import { getAigwUrl, discoverAigwModels } from "./aigw-manager.js";
import { selectAigwModelForRoleTier, resolveModelStateMeta } from "./model-registry.js";
import { isSessionSelectableModelString } from "./google-code-assist.js";
import { isKnownThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./thinking-level-clamp.js";
import { resolveSessionRuntime } from "./session-runtime.js";

export interface SessionModelsDeps {
	getPreferencesStore(): PreferencesStore | undefined;
	getConfigCascade(): ConfigCascade | null;
	getRoleManager(): RoleManager | undefined;
	resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): Role | undefined;
	resolveStoreForSession(id: string): SessionStore;
	writeModelNameFile(sessionId: string, modelId: string): void;
	persistSessionModel(sessionId: string, provider: string, modelId: string): void;
	broadcast(clients: Set<WebSocket>, msg: ServerMessage): void;
}

/**
 * Build the `state.model` payload for a live model-state broadcast. Routes
 * through `resolveModelStateMeta` (registry cache → pi-ai catalog → inferMeta)
 * so the frame carries the SAME contextWindow / maxTokens / reasoning /
 * thinkingLevelMap the ModelSelector dropdown shows. The client full-replaces
 * `state.model`, so every field must be present. `thinkingLevelMap` is omitted
 * when upstream metadata doesn't provide it.
 */
function buildModelStateData(provider: string, id: string): { model: Record<string, unknown> } {
	const meta = resolveModelStateMeta(provider, id);
	return {
		model: {
			provider,
			id,
			contextWindow: meta.contextWindow,
			maxTokens: meta.maxTokens,
			reasoning: meta.reasoning,
			...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
		},
	};
}

export class SessionModels {
	private _aigwModelCache: { url: string; models: Awaited<ReturnType<typeof discoverAigwModels>>; ts: number } | null = null;
	private static AIGW_CACHE_TTL_MS = 60_000; // 1 minute

	constructor(private readonly deps: SessionModelsDeps) {}

	private get preferencesStore(): PreferencesStore | undefined {
		return this.deps.getPreferencesStore();
	}

	private get configCascade(): ConfigCascade | null {
		return this.deps.getConfigCascade();
	}

	private get roleManager(): RoleManager | undefined {
		return this.deps.getRoleManager();
	}

	private resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): Role | undefined {
		return this.deps.resolveSessionRole(roleName, assistantType, projectId);
	}

	private resolveStoreForSession(id: string): SessionStore {
		return this.deps.resolveStoreForSession(id);
	}

	private _writeModelNameFile(sessionId: string, modelId: string): void {
		this.deps.writeModelNameFile(sessionId, modelId);
	}

	persistSessionModel(sessionId: string, provider: string, modelId: string): void {
		this.deps.persistSessionModel(sessionId, provider, modelId);
	}

	private broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
		this.deps.broadcast(clients, msg);
	}

	private readRoleStringField(role: Role | undefined, field: "model" | "thinkingLevel"): string | undefined {
		const value = role?.[field];
		if (typeof value !== "string") return undefined;
		return value.trim().length > 0 ? value : undefined;
	}

	resolveRoleModelValue(roleName: string | undefined, projectId: string | undefined): string | undefined {
		if (!roleName) return undefined;
		const cascadeValue = this.readRoleStringField(this.resolveSessionRole(roleName, undefined, projectId), "model");
		if (cascadeValue) return cascadeValue;
		if (!this.configCascade) return undefined;
		try {
			return this.configCascade.resolveRoleModel(roleName, projectId);
		} catch {
			return undefined;
		}
	}

	resolveRoleThinkingLevelValue(roleName: string | undefined, projectId: string | undefined): string | undefined {
		if (!roleName) return undefined;
		const cascadeValue = this.readRoleStringField(this.resolveSessionRole(roleName, undefined, projectId), "thinkingLevel");
		if (cascadeValue) return cascadeValue;
		if (!this.configCascade) return undefined;
		try {
			return this.configCascade.resolveRoleThinkingLevel(roleName, projectId);
		} catch {
			return undefined;
		}
	}

	/** Resolve a role-level model override for the session, if any. */
	resolveRoleModel(session: SessionInfo): string | undefined {
		return this.resolveRoleModelValue(session.role, session.projectId);
	}

	/**
	 * Resolve the role's `promptTemplate` for assembly. Prefer the
	 * field-level project→ancestor→server→builtin cascade when a projectId
	 * is in scope so a project-only override of `model` doesn't erase the
	 * inherited promptTemplate (and vice versa). Falls back to the role
	 * manager view for system-scope sessions (no projectId).
	 */
	resolveRolePromptTemplate(roleName: string, projectId: string | undefined): string | undefined {
		if (projectId && this.configCascade) {
			try {
				const t = this.configCascade.resolveRolePromptTemplate(roleName, projectId);
				if (t) return t;
			} catch { /* fall through */ }
		}
		// The field-level cascade (resolveRolePromptTemplate → resolveRoleField) walks
		// only project/server/builtin role STORES — it does NOT include pack-shipped
		// roles (e.g. `pr-reviewer`, which lives in the marketplace pack resolver and
		// is only surfaced by `resolveRoles`). Fall back to the full cascade-resolved
		// role so a pack role's promptTemplate (carrying its required YAML schema)
		// reaches the system prompt on BOTH spawn and restore. Without this a reviewer
		// child has no schema and "learns it from validation feedback".
		const packTemplate = this.resolveSessionRole(roleName, undefined, projectId)?.promptTemplate;
		if (packTemplate) return packTemplate;
		return this.roleManager?.getRole(roleName)?.promptTemplate;
	}

	/** Resolve a role-level thinkingLevel override for the session, if any. */
	resolveRoleThinkingLevel(session: SessionInfo): string | undefined {
		return this.resolveRoleThinkingLevelValue(session.role, session.projectId);
	}

	/**
	 * Resolve the model to pin at spawn time for a session, given its role &
	 * project. Mirrors `tryAutoSelectModel`'s precedence: role override →
	 * `default.sessionModel` pref. Returns `undefined` for the aigw-fallback
	 * case so post-spawn discovery + setModel still runs.
	 */
	resolveInitialModel(role: string | undefined, projectId: string | undefined): string | undefined {
		// Role override
		if (role) {
			const m = this.resolveRoleModelValue(role, projectId);
			// Skip models that can't run in an agent session (e.g. google-gemini-cli
			// Code Assist) so a role override doesn't pin an unrunnable provider.
			if (m && /^[^/]+\/.+$/.test(m) && isSessionSelectableModelString(m)) return m;
		}
		// default.sessionModel preference
		const pref = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref) && isSessionSelectableModelString(pref)) return pref;
		return undefined;
	}

	/**
	 * Resolve the thinking level to pin at spawn time for a session.
	 * Mirrors `tryApplyDefaultThinkingLevel`: role override →
	 * `default.sessionThinkingLevel` pref → "medium". Returns `undefined`
	 * for invalid values so the agent's built-in default applies.
	 */
	resolveInitialThinkingLevel(role: string | undefined, projectId: string | undefined): string | undefined {
		let candidate: string | undefined;
		if (role) {
			const t = this.resolveRoleThinkingLevelValue(role, projectId);
			const known = isKnownThinkingLevel(t);
			if (known) candidate = known;
		}
		if (!candidate) {
			const pref = this.preferencesStore?.get("default.sessionThinkingLevel") as string | undefined;
			const known = isKnownThinkingLevel(pref);
			if (known) candidate = known;
		}
		if (!candidate) candidate = "medium";
		// Defensive clamp against the resolved spawn model (if known). For
		// non-reasoning models this collapses to "off"; for older Opus models
		// "xhigh" falls back to "high". When no model is resolvable, leave the
		// candidate as-is — the per-session clamp at apply time handles it.
		const initialModelStr = this.resolveInitialModel(role, projectId);
		if (initialModelStr) {
			const slash = initialModelStr.indexOf("/");
			if (slash > 0) {
				const provider = initialModelStr.slice(0, slash);
				const modelId = initialModelStr.slice(slash + 1);
				return clampThinkingLevelForModel(candidate, provider, modelId);
			}
		}
		return candidate;
	}

	/**
	 * Resolve the review/QA model to pin at spawn time. Mirrors the
	 * verification-harness precedence: role override → `default.reviewModel`.
	 */
	resolveInitialReviewModel(role: string | undefined, projectId: string | undefined): string | undefined {
		if (role) {
			const m = this.resolveRoleModelValue(role, projectId);
			if (m && /^[^/]+\/.+$/.test(m) && isSessionSelectableModelString(m)) return m;
		}
		const pref = this.preferencesStore?.get("default.reviewModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref) && isSessionSelectableModelString(pref)) return pref;
		return undefined;
	}

	async tryAutoSelectModel(session: SessionInfo): Promise<void> {
		// If the agent was spawned with `--model <provider>/<modelId>` already,
		// skip the redundant `setModel` RPC — read-back verification still runs
		// and hard-fails on mismatch.
		const spawnPinned = !!session.spawnPinnedModel;
		const persisted = this.resolveStoreForSession(session.id).get(session.id);
		if (resolveSessionRuntime({ runtime: persisted?.runtime, modelProvider: persisted?.modelProvider }) === "claude-code") {
			return;
		}
		const allowSessionModelFallback = this.preferencesStore?.get("allowSessionModelFallback") === true;
		const fallbackSessionModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;

		// Spawn-pinned models are explicit selections too (restore/respawn persisted
		// model, role/default pin from initial setup, or caller-supplied initialModel).
		// Verify the actual bound model before the session becomes idle/live. If the
		// pinned model is stale or unavailable, never fall through to role/default
		// resolution, AIGW discovery, or SDK/provider defaults; with the opt-in policy
		// try only default.sessionModel.
		const pinnedModel = session.spawnPinnedModel;
		if (pinnedModel) {
			const safePinnedModel = sanitizeModelErrorText(pinnedModel);
			let pinnedModelError;
			if (!isSessionSelectableModelString(pinnedModel)) {
				pinnedModelError = new Error(`spawn-pinned model "${safePinnedModel}" is not session-selectable`);
			} else {
				try {
					await applyModelString(session.rpcClient, pinnedModel, {
						sessionManager: this,
						sessionId: session.id,
						contextLabel: "spawn-pinned model",
						skipSetModel: true,
					});
					this._writeModelNameFile(session.id, pinnedModel);
					const slash = pinnedModel.indexOf("/");
					const provider = pinnedModel.slice(0, slash);
					const modelId = pinnedModel.slice(slash + 1);
					this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
					this.broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
					if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Verified spawn-pinned model "${pinnedModel}" for session ${session.id}`);
					return;
				} catch (err) {
					pinnedModelError = err;
				}
			}

			if (allowSessionModelFallback) {
				let controlledFallbackError;
				if (!fallbackSessionModel) {
					controlledFallbackError = new Error("controlled model fallback is enabled but default.sessionModel is unset");
				} else if (!isSessionSelectableModelString(fallbackSessionModel)) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel="${fallbackSessionModel}" is not session-selectable`);
				} else if (fallbackSessionModel === pinnedModel) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel is the same as failed spawn-pinned model "${safePinnedModel}"`);
				}
				if (!controlledFallbackError && fallbackSessionModel) {
					try {
						const pinnedMsg = sanitizeModelErrorText(pinnedModelError);
						const safeFallbackSessionModel = sanitizeModelErrorText(fallbackSessionModel);
						console.warn(`[session-manager] Spawn-pinned model "${safePinnedModel}" failed for ${session.id}; controlled fallback enabled, trying default.sessionModel="${safeFallbackSessionModel}": ${pinnedMsg}`);
						await applyModelString(session.rpcClient, fallbackSessionModel, {
							sessionManager: this,
							sessionId: session.id,
							contextLabel: "default.sessionModel fallback",
						});
						this._writeModelNameFile(session.id, fallbackSessionModel);
						const slash = fallbackSessionModel.indexOf("/");
						const provider = fallbackSessionModel.slice(0, slash);
						const modelId = fallbackSessionModel.slice(slash + 1);
						this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
						this.broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
						console.log(`[session-manager] Controlled fallback selected default.sessionModel "${fallbackSessionModel}" for session ${session.id} after spawn-pinned model "${pinnedModel}" failed`);
						return;
					} catch (fallbackErr) {
						controlledFallbackError = fallbackErr;
					}
				}
				const originalMsg = sanitizeModelErrorText(pinnedModelError);
				const fallbackMsg = sanitizeModelErrorText(controlledFallbackError);
				throw new Error(`spawn-pinned model "${safePinnedModel}" failed and controlled fallback did not bind; original error: ${originalMsg}; fallback error: ${fallbackMsg}`);
			}

			console.error(`[session-manager] Spawn-pinned model "${safePinnedModel}" failed for ${session.id}: ${sanitizeModelErrorForLog(pinnedModelError)}`);
			throw (pinnedModelError instanceof Error && pinnedModelError.message === sanitizeModelErrorText(pinnedModelError)) ? pinnedModelError : new Error(sanitizeModelErrorText(pinnedModelError));
		}

		// 0. Role override (highest explicit precedence). If it fails, never fall
		// through to discovery/provider defaults. With the opt-in policy, try only
		// default.sessionModel as the controlled fallback target.
		const roleModel = this.resolveRoleModel(session);
		if (roleModel) {
			const safeRoleModel = sanitizeModelErrorText(roleModel);
			let roleModelError;
			if (!isSessionSelectableModelString(roleModel)) {
				roleModelError = new Error(`role.${session.role}.model "${safeRoleModel}" is not session-selectable`);
			} else {
				try {
					await applyModelString(session.rpcClient, roleModel, {
						sessionManager: this,
						sessionId: session.id,
						contextLabel: `role.${session.role}.model`,
						skipSetModel: spawnPinned && session.spawnPinnedModel === roleModel,
					});
					this._writeModelNameFile(session.id, roleModel);
					const slash = roleModel.indexOf("/");
					const provider = roleModel.slice(0, slash);
					const modelId = roleModel.slice(slash + 1);
					this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
					this.broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
					console.log(`[session-manager] Set role-override model "${roleModel}" for session ${session.id} (role=${session.role})`);
					return;
				} catch (err) {
					roleModelError = err;
				}
			}

			if (allowSessionModelFallback) {
				let controlledFallbackError;
				if (!fallbackSessionModel) {
					controlledFallbackError = new Error("controlled model fallback is enabled but default.sessionModel is unset");
				} else if (!isSessionSelectableModelString(fallbackSessionModel)) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel="${fallbackSessionModel}" is not session-selectable`);
				} else if (fallbackSessionModel === roleModel) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel is the same as failed role model "${safeRoleModel}"`);
				}
				if (!controlledFallbackError && fallbackSessionModel) {
					try {
						const roleMsg = sanitizeModelErrorText(roleModelError);
						const safeFallbackSessionModel = sanitizeModelErrorText(fallbackSessionModel);
						console.warn(`[session-manager] Role model "${safeRoleModel}" failed for ${session.id}; controlled fallback enabled, trying default.sessionModel="${safeFallbackSessionModel}": ${roleMsg}`);
						await applyModelString(session.rpcClient, fallbackSessionModel, {
							sessionManager: this,
							sessionId: session.id,
							contextLabel: "default.sessionModel fallback",
							skipSetModel: spawnPinned && session.spawnPinnedModel === fallbackSessionModel,
						});
						this._writeModelNameFile(session.id, fallbackSessionModel);
						const slash = fallbackSessionModel.indexOf("/");
						const provider = fallbackSessionModel.slice(0, slash);
						const modelId = fallbackSessionModel.slice(slash + 1);
						this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
						this.broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
						console.log(`[session-manager] Controlled fallback selected default.sessionModel "${fallbackSessionModel}" for session ${session.id} after role model "${roleModel}" failed`);
						return;
					} catch (fallbackErr) {
						controlledFallbackError = fallbackErr;
					}
				}
				const originalMsg = sanitizeModelErrorText(roleModelError);
				const fallbackMsg = sanitizeModelErrorText(controlledFallbackError);
				throw new Error(`role model "${safeRoleModel}" failed and controlled fallback did not bind; original error: ${originalMsg}; fallback error: ${fallbackMsg}`);
			}

			console.error(`[session-manager] Role model "${safeRoleModel}" failed for ${session.id}: ${sanitizeModelErrorForLog(roleModelError)}`);
			throw (roleModelError instanceof Error && roleModelError.message === sanitizeModelErrorText(roleModelError)) ? roleModelError : new Error(sanitizeModelErrorText(roleModelError));
		}

		if (!this.preferencesStore) return;

		// Check explicit preference first (works for both aigw and public providers).
		// default.sessionModel itself is not fallback-eligible: any malformed,
		// non-session-selectable, unavailable, or read-back-mismatched value fails
		// loudly and never falls through to AIGW or provider defaults.
		const sessionModelPref = this.preferencesStore.get("default.sessionModel") as string | undefined;
		if (sessionModelPref) {
			const safeSessionModelPref = sanitizeModelErrorText(sessionModelPref);
			if (!isSessionSelectableModelString(sessionModelPref)) {
				throw new Error(`default.sessionModel "${safeSessionModelPref}" is not session-selectable`);
			}
			const slash = sessionModelPref.indexOf("/");
			const provider = sessionModelPref.slice(0, slash);
			const modelId = sessionModelPref.slice(slash + 1);
			const preSpawnPinned = spawnPinned && session.spawnPinnedModel === sessionModelPref;
			try {
				// Route through applyModelString to preserve the hard-fail-on-mismatch
				// contract (read-back via getState()) regardless of whether we skipped
				// the redundant setModel RPC because the spawn already pinned the same model.
				await applyModelString(session.rpcClient, sessionModelPref, {
					sessionManager: this,
					sessionId: session.id,
					contextLabel: "default.sessionModel",
					skipSetModel: preSpawnPinned,
				});
				this._writeModelNameFile(session.id, sessionModelPref);
				this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
				if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Set preferred model "${sessionModelPref}" for session ${session.id}${preSpawnPinned ? " (spawn-pinned)" : ""}`);
				this.broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
				return;
			} catch (err) {
				console.error(`[session-manager] default.sessionModel "${safeSessionModelPref}" failed for ${session.id}; controlled fallback is not eligible for the default session model: ${sanitizeModelErrorForLog(err)}`);
				throw (err instanceof Error && err.message === sanitizeModelErrorText(err)) ? err : new Error(sanitizeModelErrorText(err));
			}
		}

		// Fall back to aigw best-ranked model only when no explicit role/default
		// session model was selected.
		const aigwUrl = getAigwUrl(this.preferencesStore);
		if (!aigwUrl) return;

		let aigwModels;
		try {
			// Use cached model list if fresh (avoids HTTP round-trip per session)
			if (this._aigwModelCache && this._aigwModelCache.url === aigwUrl &&
				Date.now() - this._aigwModelCache.ts < SessionModels.AIGW_CACHE_TTL_MS) {
				aigwModels = this._aigwModelCache.models;
			} else {
				aigwModels = await discoverAigwModels(aigwUrl);
				this._aigwModelCache = { url: aigwUrl, models: aigwModels, ts: Date.now() };
			}
		} catch (err) {
			console.warn(`[session-manager] Failed to discover aigw models for auto-selection:`, err);
			return;
		}
		if (aigwModels.length === 0) return;

		try {
			// F5-model-aigw: role-tier-aware pick — "low" tier roles (docs-writer)
			// get the cheapest discovered model instead of the newest/priciest one
			// every session got before. See selectAigwModelForRoleTier() for why
			// this is availability-safe (always picks among already-discovered
			// models, never a hardcoded literal).
			const roleTierForAigw = this.resolveRoleThinkingLevel(session);
			const modelToUse = selectAigwModelForRoleTier(aigwModels, roleTierForAigw);

			await session.rpcClient.setModel("aigw", modelToUse.id);
			this._writeModelNameFile(session.id, modelToUse.id);
			this.resolveStoreForSession(session.id).update(session.id, { modelProvider: "aigw", modelId: modelToUse.id });
			console.log(`[session-manager] Auto-selected aigw model "${modelToUse.id}" for session ${session.id}${roleTierForAigw === "low" ? " (low-tier role: cheapest discovered model)" : ""}`);

			this.broadcast(session.clients, { type: "state", data: buildModelStateData("aigw", modelToUse.id) });
		} catch (err) {
			console.warn(`[session-manager] Failed to auto-select model for ${session.id}:`, err);
		}
	}

	/** Apply default thinking level from preferences (per-model). */
	async tryApplyDefaultThinkingLevel(session: SessionInfo): Promise<void> {
		// 0. Role override (highest non-explicit precedence). Failure is non-fatal
		// — matches the existing thinking-level fallback behaviour.
		const spawnPinnedThinking = session.spawnPinnedThinkingLevel;
		const roleThinking = this.resolveRoleThinkingLevel(session);
		if (roleThinking) {
			if (spawnPinnedThinking === roleThinking) {
				if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Role thinking level "${roleThinking}" already pinned at spawn for ${session.id}`);
				return;
			}
			try {
				await session.rpcClient.setThinkingLevel(roleThinking);
				console.log(`[session-manager] Applied role thinking level "${roleThinking}" for session ${session.id} (role=${session.role})`);
				return;
			} catch (err) {
				console.warn(`[session-manager] Role thinking level "${roleThinking}" failed for ${session.id}:`, err);
				// Fall through to global default — thinking-level mismatch is non-fatal
			}
		}

		// Use the per-model thinking preference (system-scope), default to "medium".
		let level: string | undefined;
		if (this.preferencesStore) {
			level = this.preferencesStore.get("default.sessionThinkingLevel") as string | undefined;
		}
		// Default to "medium" when not configured — matches the Settings page
		// display default and ensures team/delegate agents get an explicit level
		// instead of relying on the agent's built-in default.
		if (!level) level = "medium";
		const knownLevel = isKnownThinkingLevel(level);
		if (!knownLevel) return;
		level = knownLevel;
		// Clamp against the session's current model when known so xhigh on a
		// non-supporting model degrades to high (etc.) at apply time.
		try {
			const persisted = this.resolveStoreForSession(session.id).get(session.id);
			if (persisted?.modelId) {
				const clamped = clampThinkingLevelForModel(level, persisted.modelProvider, persisted.modelId);
				if (clamped) level = clamped;
			}
		} catch { /* best-effort */ }
		if (spawnPinnedThinking === level) {
			if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Default thinking level "${level}" already pinned at spawn for ${session.id}`);
			return;
		}
		try {
			await session.rpcClient.setThinkingLevel(level);
			console.log(`[session-manager] Applied default thinking level "${level}" for session ${session.id}`);
		} catch (err) {
			console.warn(`[session-manager] Failed to apply default thinking level for ${session.id}:`, err);
		}
	}
}

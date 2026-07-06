/**
 * Session prompt/tool activation plumbing - SessionManager decomposition cohort 12.
 *
 * SessionManager keeps same-named wrappers for callers and source-shape tests,
 * while workflow prompt snippets, goal-metadata tool filtering, activation args,
 * skills catalog population, and prompt-section reconstruction live here.
 */
import os from "node:os";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { headquartersDir, bobbitStateDir } from "../bobbit-dir.js";
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
import { hasProviderBridgeHooks, writeProviderBridgeExtension } from "./provider-bridge-extension.js";
import { resolveRolePrompt } from "./role-prompt.js";
import type { RuntimePiExtensionInfo } from "./rpc-bridge.js";
import type { SessionInfo } from "./session-manager.js";
import type { SessionStore } from "./session-store.js";
import {
	type MarketplacePiExtensionActivation,
	scopedToolContext,
} from "./session-setup.js";
import { assembleSystemPrompt, persistPromptSections, type PromptParts } from "./system-prompt.js";
import {
	computeEffectiveAllowedTools,
	computeToolActivationArgs,
	writeMcpProxyExtensions,
	writeToolGuardExtension,
	type EffectiveTool,
} from "./tool-activation.js";
import { prependToolResultErrorBridge } from "./tool-result-error-bridge-extension.js";
import { writeGoogleCodeAssistProviderExtension } from "./google-code-assist-provider-extension.js";
import { writeOpenAiOrphanToolResultExtension } from "./openai-orphan-tool-result-extension.js";
import { discoverSlashSkills, type SkillMarketContext } from "../skills/slash-skills.js";
import { profile } from "./profiling.js";
import type { ConfigCascade } from "./config-cascade.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { PersistedGoal } from "./goal-store.js";
import type { GoalManager } from "./goal-manager.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { ProjectConfigStore } from "./project-config-store.js";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { PrStatusStore } from "./pr-status-store.js";
import type { GrantPolicy } from "./role-store.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import type { ToolManager } from "./tool-manager.js";

/**
 * F22 (RECONCILIATION-2026-07-05.md NEXT QUEUE item 5) — tool names that are
 * safe within a "narrow worker" delegate's scope: pure file/shell primitives
 * with no team/goal/gate/review/task orchestration surface. Used by
 * `isNarrowDelegateAllowedTools` to decide whether a delegate's spawn-time
 * `allowedTools` PROVES the spawn is bounded to a single coding task, as
 * opposed to one that still needs team/goal awareness.
 *
 * NOT the same axis as `read-only-tool-policy.ts`'s `isReadOnlyToolPolicy`
 * (eligibility-signal lane), even though both derive a session-class signal
 * from the resolved `allowedTools` instead of an opt-in flag/name. This is an
 * ALLOW-list that deliberately INCLUDES `write`/`edit`/`bash`/`bash_bg` — a
 * narrow delegate is still allowed to mutate files, it's just proven to be
 * scoped to one bounded coding task. `isReadOnlyToolPolicy` is the opposite:
 * a DENY-list that excludes any of those same tools. Forcing them onto one
 * shared constant would contort whichever one lost — kept deliberately
 * separate, cross-referenced here so they don't silently diverge in intent.
 */
const NARROW_WORKER_TOOLS: ReadonlySet<string> = new Set([
	"read", "write", "edit", "grep", "find", "ls", "bash", "bash_bg", "read_session", "activate_skill",
]);

/**
 * F22 narrowness criterion: a delegate is PROVABLY narrow iff it was spawned
 * with a non-empty, explicit `allowedTools` allow-list drawn entirely from
 * `NARROW_WORKER_TOOLS`. `undefined`/empty `allowedTools` (unrestricted, or
 * inheriting the parent's full surface) is conservatively NOT narrow — the
 * spawn metadata can't prove the child is scoped to a bounded coding task, so
 * it keeps the full prompt (see `buildDelegatePromptParts`).
 */
export function isNarrowDelegateAllowedTools(allowedTools?: string[]): boolean {
	if (!allowedTools || allowedTools.length === 0) return false;
	return allowedTools.every(t => NARROW_WORKER_TOOLS.has(t.toLowerCase()));
}

export interface SessionPromptPlumbingDeps {
	getSystemPromptPath(): string | undefined;
	getSessions(): Map<string, SessionInfo>;
	getProjectConfigStore(): ProjectConfigStore | undefined;
	getProjectContextManager(): ProjectContextManager | null;
	getConfigCascade(): ConfigCascade | null;
	getToolManager(): ToolManager | undefined;
	getGroupPolicyStore(): ToolGroupPolicyStore | undefined;
	getRoleManager(): RoleManager | undefined;
	getPreferencesStore(): PreferencesStore | undefined;
	getPrStatusStore(): PrStatusStore | null;
	getLifecycleHub(): LifecycleHub | undefined;
	getMcpManager(): McpManager | null;
	getMcpManagerForContext(projectId?: string, cwd?: string): McpManager | null;
	resolveStoreForId(id: string): SessionStore | null;
	resolveStoreForSession(id: string): SessionStore;
	resolveGoal(goalId: string): PersistedGoal | undefined;
	resolveRolePromptTemplate(roleName: string, projectId?: string): string | undefined;
	getIsSubgoalsEnabled(): boolean;
	resolveMarketplacePiExtensionArgs(projectId?: string, cwd?: string): MarketplacePiExtensionActivation;
	getTestGoalManager(): GoalManager | null | undefined;
}

export class SessionPromptPlumbing {
	constructor(private readonly deps: SessionPromptPlumbingDeps) {}

	private get systemPromptPath(): string | undefined { return this.deps.getSystemPromptPath(); }
	private get sessions(): Map<string, SessionInfo> { return this.deps.getSessions(); }
	private get projectConfigStore(): ProjectConfigStore | undefined { return this.deps.getProjectConfigStore(); }
	private get projectContextManager(): ProjectContextManager | null { return this.deps.getProjectContextManager(); }
	private get configCascade(): ConfigCascade | null { return this.deps.getConfigCascade(); }
	private get toolManager(): ToolManager | undefined { return this.deps.getToolManager(); }
	private get groupPolicyStore(): ToolGroupPolicyStore | undefined { return this.deps.getGroupPolicyStore(); }
	private get roleManager(): RoleManager | undefined { return this.deps.getRoleManager(); }
	private get preferencesStore(): PreferencesStore | undefined { return this.deps.getPreferencesStore(); }
	private get prStatusStore(): PrStatusStore | null { return this.deps.getPrStatusStore(); }
	private get lifecycleHub(): LifecycleHub | undefined { return this.deps.getLifecycleHub(); }
	private get mcpManager(): McpManager | null { return this.deps.getMcpManager(); }
	private get isSubgoalsEnabled(): boolean { return this.deps.getIsSubgoalsEnabled(); }

	private getMcpManagerForContext(projectId?: string, cwd?: string): McpManager | null {
		return this.deps.getMcpManagerForContext(projectId, cwd);
	}

	private resolveStoreForId(id: string): SessionStore | null {
		return this.deps.resolveStoreForId(id);
	}

	private resolveStoreForSession(id: string): SessionStore {
		return this.deps.resolveStoreForSession(id);
	}

	private resolveGoal(goalId: string): PersistedGoal | undefined {
		return this.deps.resolveGoal(goalId);
	}

	private resolveRolePromptTemplate(roleName: string, projectId?: string): string | undefined {
		return this.deps.resolveRolePromptTemplate(roleName, projectId);
	}

	private resolveMarketplacePiExtensionArgs(projectId?: string, cwd?: string): MarketplacePiExtensionActivation {
		return this.deps.resolveMarketplacePiExtensionArgs(projectId, cwd);
	}

	/** Build a markdown list of available workflows for the goal assistant prompt. */
	_buildWorkflowList(projectId?: string): string {
		let workflows: import("./workflow-store.js").Workflow[] = [];
		if (projectId && this.configCascade) {
			workflows = this.configCascade.resolveWorkflows(projectId).map(r => r.item);
		} else if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) workflows = ctx.workflowStore.getAll();
		}
		if (!workflows || workflows.length === 0) {
			return '⚠️ This project has no workflows configured. You CANNOT propose a goal yet — the user must run the project assistant first to scaffold workflows. Do not call propose_goal. Instead tell the user "this project has no workflows yet; open the project assistant from Settings → Components (or click the banner in the goal panel) to set them up", and stop.';
		}
		return workflows.map(w => {
			const gateNames = w.gates.map(g => g.name).join(', ');
			return `- **${w.id}** (${w.name}) — ${w.description}. Gates: ${gateNames}.`;
		}).join('\n');
	}

	/**
	 * Build the full set of CLI args for tool activation, including guard extensions,
	 * MCP proxies, and builtin/extension activation.
	 *
	 * Returns the args array to prepend to bridgeOptions.args.
	 */
	/**
	 * Resolve the effective allowed tools for a role.
	 * If the role has explicit allowedTools, use those.
	 * Otherwise, compute from the full policy cascade (honouring the allow default).
	 */
	resolveEffectiveAllowedTools(role: import("./role-store.js").Role | undefined): EffectiveTool[] {
		if (!role) return [];
		if (this.toolManager) {
			return computeEffectiveAllowedTools(this.toolManager, role, this.groupPolicyStore, this.mcpManager ?? undefined);
		}
		return [];
	}

	mergeToolNames(existing: string[] | undefined, additions: string[] | undefined): string[] | undefined {
		const merged: string[] = [];
		const seen = new Set<string>();
		for (const name of [...(existing ?? []), ...(additions ?? [])]) {
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(name);
		}
		return merged.length > 0 ? merged : undefined;
	}

	/**
	 * Resolve a session's effective (ancestry-merged) goal metadata for the
	 * restore / respawn / force-abort tool-activation paths. Routes by goal id
	 * (mirrors the lifecycle-hub's getContextForGoal routing), falling back to
	 * the project's GoalManager, then the in-process test GoalManager. Returns
	 * `{}` (a guarded no-op) when there is no goal or no manager. Never throws —
	 * metadata is best-effort and must not break a respawn.
	 */
	resolveEffectiveGoalMetadataForSession(goalId: string | undefined, projectId?: string): Record<string, unknown> {
		if (!goalId) return {};
		try {
			if (this.projectContextManager) {
				const ctx = this.projectContextManager.getContextForGoal(goalId)
					?? (projectId ? this.projectContextManager.getOrCreate(projectId) : undefined);
				if (ctx) return ctx.goalManager.getEffectiveGoalMetadata(goalId) ?? {};
			}
			if (this.deps.getTestGoalManager()) return this.deps.getTestGoalManager()!.getEffectiveGoalMetadata(goalId) ?? {};
		} catch (err) {
			console.warn(`[session-manager] resolveEffectiveGoalMetadata failed for goal ${goalId} (non-fatal):`, err);
		}
		return {};
	}

	/**
	 * Dispatch the `goalProvisioned` lifecycle hook for a worktree provisioned
	 * OUTSIDE the GoalManager / session-setup provisioning paths — specifically
	 * the team-manager member worktrees, which `createWorktree()`s directly and
	 * hands a pre-built cwd to `createSession` (so session-setup's provisioning
	 * dispatch never fires for them). Resolves the member's EFFECTIVE goal
	 * metadata through the single resolver (no ad-hoc ancestry walk) so
	 * metadata-driven filesystem treatments land on every normal member worktree,
	 * symmetric with the goal/cold-create/pool paths. Non-fatal — never blocks
	 * a spawn. No-op when no lifecycle hub, no goal, or no worktree.
	 */
	async dispatchGoalProvisionedForWorktree(opts: {
		goalId: string | undefined;
		projectId?: string;
		worktreePath: string;
		cwd: string;
		branch?: string;
	}): Promise<void> {
		if (!this.lifecycleHub) return;
		if (!opts.goalId || !opts.worktreePath) return;
		try {
			const metadata = this.resolveEffectiveGoalMetadataForSession(opts.goalId, opts.projectId);
			await this.lifecycleHub.dispatchGoalProvisioned({
				goalId: opts.goalId,
				projectId: opts.projectId,
				worktreePath: opts.worktreePath,
				cwd: opts.cwd,
				branch: opts.branch,
				metadata,
			});
		} catch (err) {
			console.warn(`[session-manager] goalProvisioned dispatch for member worktree ${opts.worktreePath} (goal ${opts.goalId}) failed (non-fatal):`, err);
		}
	}

	/**
	 * Lower-cased set of tool names disabled via the `bobbit.disabledTools`
	 * metadata convention for a session's effective goal; undefined when none.
	 * Mirrors session-setup.ts::disabledToolsFromMetadata so the restore /
	 * respawn / force-abort paths apply the same disablement as initial setup.
	 */
	disabledToolsForGoal(goalId: string | undefined, projectId?: string): ReadonlySet<string> | undefined {
		const raw = this.resolveEffectiveGoalMetadataForSession(goalId, projectId)["bobbit.disabledTools"];
		if (!Array.isArray(raw)) return undefined;
		const names = raw.filter((v): v is string => typeof v === "string" && v.length > 0).map(s => s.toLowerCase());
		return names.length > 0 ? new Set(names) : undefined;
	}

	/**
	 * Prompt section order from the `bobbit.promptSectionOrder` metadata
	 * convention for a session's effective goal; undefined when none. Mirrors
	 * session-setup.ts::promptSectionOrderFromMetadata so the restore / respawn
	 * paths reorder prompt sections the same way initial setup does — without
	 * this a restored session under a goal with a custom order silently reverts
	 * to the default prompt order after a gateway restart.
	 */
	promptSectionOrderForGoal(goalId: string | undefined, projectId?: string): string[] | undefined {
		const raw = this.resolveEffectiveGoalMetadataForSession(goalId, projectId)["bobbit.promptSectionOrder"];
		if (!Array.isArray(raw)) return undefined;
		const order = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
		return order.length > 0 ? order : undefined;
	}

	buildToolActivationArgs(
		sessionId: string,
		allowedTools: EffectiveTool[] | undefined,
		role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
		cwd: string,
		projectId?: string,
		effectiveGoalId?: string,
		grantedTools?: string[],
	): { args: string[]; env: Record<string, string>; runtimeExtensions: RuntimePiExtensionInfo[] } {
		// Goal-metadata disabled tools (bobbit.disabledTools). Resolved from the
		// session's EFFECTIVE goal (goalId ?? teamGoalId, threaded by the caller)
		// so restart/respawn/force-abort keep the same disablement initial setup
		// applied — without this a restored session re-acquires disabled tools.
		const disabledTools = this.disabledToolsForGoal(effectiveGoalId, projectId);
		const filteredAllowed = disabledTools && allowedTools
			? allowedTools.filter(e => !disabledTools.has(e.name.toLowerCase()))
			: allowedTools;
		const flatNames = filteredAllowed?.map(e => e.name);
		const toolScope = scopedToolContext(projectId, cwd);

		const mcpManager = this.getMcpManagerForContext(projectId, cwd);

		// MCP proxy extensions
		const mcpExtPaths = mcpManager
			? writeMcpProxyExtensions(mcpManager, flatNames, role, this.toolManager, this.groupPolicyStore, disabledTools, toolScope)
			: undefined;

		// Builtin + bobbit-extension activation
		const activation = computeToolActivationArgs(filteredAllowed, this.toolManager, cwd, mcpExtPaths, disabledTools, toolScope);
		const piExtensionActivation = this.resolveMarketplacePiExtensionArgs(projectId, cwd);

		const args = prependToolResultErrorBridge([...activation.args, ...piExtensionActivation.args]);

		// Compute session-specific grants (tools in allowedTools but not in the role's base allowedTools)
		// and layer explicit grant records on top. Ask-gated tools are part of the
		// effective role surface so the derived diff alone cannot identify that a
		// session-only approval should pre-populate the guard after restart. One-time
		// approvals are intentionally not threaded into grantedTools; the guard lets
		// only the blocked invocation continue based on the grant response mode.
		const roleBaseTools = role && this.toolManager
			? computeEffectiveAllowedTools(this.toolManager, role as import("./role-store.js").Role, this.groupPolicyStore, mcpManager ?? undefined, toolScope)
			: [];
		const roleAllowed = new Set(roleBaseTools.map(t => t.name.toLowerCase()));
		const derivedSessionGrants = (flatNames ?? []).filter(t => !roleAllowed.has(t.toLowerCase()));
		const sessionGrants = this.mergeToolNames(derivedSessionGrants, grantedTools) ?? [];

		// Tool guard extension for 'ask' policy tools
		const guardPath = this.toolManager
			? writeToolGuardExtension(sessionId, this.toolManager, mcpManager ?? undefined, role, this.groupPolicyStore, sessionGrants, disabledTools, toolScope)
			: undefined;
		if (guardPath) {
			args.push("--extension", guardPath);
		}

		// Provider-bridge extension (per-turn beforePrompt / beforeCompact hooks).
		// Mirrors session-setup.ts::resolveToolActivation so respawn/restore paths
		// (restore, role reassignment, force-abort respawn) keep the bridge that
		// initial setup added. Without this, provider-enabled sessions lose the
		// bridge after a gateway restart/respawn and per-turn hooks stop firing.
		// The effective goal id filters disabled providers (bobbit.disabledProviders)
		// so a goal that disabled a provider stays bridge-free after respawn too.
		// Zero overhead when no enabled provider declares those hooks — the bridge
		// is neither written nor pushed onto the spawn args.
		if (this.lifecycleHub && hasProviderBridgeHooks(this.lifecycleHub, projectId, effectiveGoalId)) {
			const bridgePath = writeProviderBridgeExtension(sessionId);
			if (bridgePath) {
				args.push("--extension", bridgePath);
			}
		}

		// OpenAI Responses preflight guard. Mirrors session setup so restore,
		// role-reassignment, and force-abort respawn paths keep dropping orphan
		// function_call_output items before provider requests are sent.
		const openAiOrphanGuardPath = writeOpenAiOrphanToolResultExtension();
		if (openAiOrphanGuardPath) {
			args.push("--extension", openAiOrphanGuardPath);
		}

		// Google account (Code Assist) provider extension. Mirrors
		// session-setup.ts::resolveToolActivation so respawn/restore paths keep the
		// provider registered and `google-gemini-cli/*` models stay runnable after a
		// gateway restart. Written unconditionally (not credential-gated) so a
		// session spawned before Google sign-in can bind such a model after auth.
		const codeAssistPath = writeGoogleCodeAssistProviderExtension(sessionId);
		if (codeAssistPath) {
			args.push("--extension", codeAssistPath);
		}

		return { args, env: activation.env, runtimeExtensions: piExtensionActivation.runtimeExtensions };
	}

	resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): import("./role-store.js").Role | undefined {
		const name = roleName || (assistantType ? "assistant" : "general");
		// Cascade-first: pack-shipped roles (e.g. `pr-reviewer`) live in the config
		// cascade, not the in-memory RoleManager. Resolving via roleManager alone
		// returns `undefined` for a pack role, which on the restore / force-respawn
		// paths drops its tools (guard falls through to group defaults). Always ask
		// the cascade, even without projectId, so server-scope/builtin market-pack
		// roles work for system-scope sessions too.
		if (this.configCascade) {
			try {
				const match = this.configCascade.resolveRoles(projectId).find(r => r.item.name === name);
				if (match) return match.item;
			} catch { /* fall through to roleManager */ }
		}
		return this.roleManager?.getRole(name);
	}

	/** Generate tool docs and inject into prompt parts before assembly. */
	assemblePrompt(sessionId: string, parts: PromptParts): string | undefined {
		return profile("sessionManager.assemblePrompt", () => this._assemblePrompt(sessionId, parts));
	}

	_assemblePrompt(sessionId: string, parts: PromptParts): string | undefined {
		if (!parts.serverConfigStore) parts.serverConfigStore = this.projectConfigStore;
		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), undefined, undefined, parts);
		}
		// Skills catalog — progressive disclosure (level 1) for autonomous activation.
		// Skipped when the session lacks `activate_skill` (catalog is useless without
		// the activator) or when explicitly already populated.
		if (!parts.skillsCatalog) {
			const catalogProjectId = this.sessions.get(sessionId)?.projectId;
			parts.skillsCatalog = this.computeSkillsCatalog(parts.allowedTools, parts.projectRoot || parts.cwd, parts.projectConfigStore, catalogProjectId);
		}
		// Stamp the user-configured skills-catalog byte budget onto the parts so it flows
		// into both the assembled prompt and the persisted prompt-sections snapshot.
		if (parts.skillsCatalogBudget === undefined && this.preferencesStore) {
			const pref = this.preferencesStore.get("skillsCatalogBudget");
			if (typeof pref === "number" && Number.isFinite(pref)) {
				parts.skillsCatalogBudget = pref;
			}
		}
		// Cache parts for prompt-sections API
		const session = this.sessions.get(sessionId);
		if (session) session.promptParts = parts;
		// Persist prompt sections snapshot for the inspector
		persistPromptSections(sessionId, parts);
		return assembleSystemPrompt(sessionId, parts);
	}

	projectConfigStoreForPrompt(projectId?: string): import("./project-config-store.js").ProjectConfigStore | undefined {
		if (projectId && this.projectContextManager) {
			return this.projectContextManager.getOrCreate(projectId)?.projectConfigStore ?? this.projectConfigStore;
		}
		return this.projectConfigStore;
	}

	/**
	 * Build the skills-catalog list for autonomous activation.
	 * Returns undefined when activate_skill is not allowed for the session
	 * (signalling "no Available Skills section" to assembleSystemPrompt).
	 */
	computeSkillsCatalog(
		allowedTools: string[] | undefined,
		discoveryRoot: string,
		projectConfigStore?: { get(key: string): string | undefined },
		projectId?: string,
	): import("../skills/slash-skills.js").SlashSkill[] | undefined {
		// allowedTools=undefined => unrestricted; include the catalog.
		// allowedTools=[] (EXPLICIT no tools, e.g. a recursion-stripped delegate or
		// a session emptied by bobbit.disabledTools) => no activate_skill, so emit
		// NO Available Skills affordance. A non-empty allowlist must contain
		// activate_skill for the catalog to appear. `[].some(...)` is false, so an
		// empty allowlist correctly returns undefined here.
		if (allowedTools) {
			const hasActivate = allowedTools.some(t => t.toLowerCase() === "activate_skill");
			if (!hasActivate) return undefined;
		}
		try {
			// Best-available market-scope wiring (finding #3): thread the server
			// base + server config store so server/global-user market skill packs
			// resolve for the active project even when its root != server cwd.
			const headquartersScope = projectId === HEADQUARTERS_PROJECT_ID;
			const marketContext: SkillMarketContext = {
				serverBase: headquartersDir(),
				globalUserBase: os.homedir(),
				projectBase: headquartersScope ? "" : discoveryRoot,
				serverConfigStore: this.projectConfigStore,
				projectConfigStore: headquartersScope ? undefined : projectConfigStore as SkillMarketContext["projectConfigStore"],
				// pack-schema-v1 §7: filter disabled market-pack skills out of the runtime
				// activation catalog too, using the SAME pack_activation store (server/
				// global-user → server config store; project → the project's config store).
				packActivation: (scope, packName) => {
					const store = scope === "project"
						? (!headquartersScope && projectId && this.projectContextManager
							? this.projectContextManager.getOrCreate(projectId)?.projectConfigStore
							: undefined)
						: this.projectConfigStore;
					return store?.getPackActivation(scope, packName) ?? {};
				},
			};
			const all = discoverSlashSkills(discoveryRoot, projectConfigStore, marketContext);
			// Filter: omit disable-model-invocation and skills with empty descriptions.
			// userInvocable=false skills are already filtered by discoverSlashSkills.
			return all.filter(s => s.disableModelInvocation !== true && (s.description?.trim() || "").length > 0);
		} catch (err) {
			console.warn(`[session-manager] Failed to discover skills for catalog (root=${discoveryRoot}):`, err);
			return undefined;
		}
	}

	buildDelegateTaskSpec(instructions: string, context?: Record<string, string>): string {
		let taskSpec = instructions;
		if (context && Object.keys(context).length > 0) {
			taskSpec += "\n\n## Context";
			for (const [key, value] of Object.entries(context)) {
				taskSpec += `\n- **${key}**: ${value}`;
			}
		}
		return taskSpec;
	}

	buildDelegatePromptParts(opts: {
		cwd: string;
		projectRoot?: string;
		instructions: string;
		context?: Record<string, string>;
		allowedTools?: string[];
		sectionOrder?: string[];
	}): PromptParts {
		// F22: a PROVABLY narrow delegate (allowedTools restricted entirely to
		// file/shell primitives — see isNarrowDelegateAllowedTools) gets the
		// "narrow-worker" profile: the nearest AGENTS.md only (no ancestor
		// config-dir cascade — achieved by omitting projectConfigStore below,
		// which falls back to readAgentsMd()'s single-nearest-file behavior)
		// and no branch-discipline rationale in the Working Directory section
		// (handled inside assembleSystemPrompt via promptProfile). Unrestricted
		// allowedTools (undefined/empty) cannot prove narrowness, so it keeps
		// the full cascade + full prompt — conservative by construction.
		const narrow = isNarrowDelegateAllowedTools(opts.allowedTools);
		return {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: opts.cwd,
			projectRoot: opts.projectRoot,
			// Delegates carry a durable task, not a goal. Older spawn code mapped this
			// through goalSpec before the live SessionInfo existed; reconstruction uses
			// the existing Task renderer so the inspector shows one task-oriented section
			// and never duplicates the instructions across Goal + Task.
			taskTitle: "Delegate Task",
			taskSpec: this.buildDelegateTaskSpec(opts.instructions, opts.context),
			allowedTools: opts.allowedTools,
			projectConfigStore: narrow ? undefined : this.projectConfigStore,
			serverConfigStore: this.projectConfigStore,
			sectionOrder: opts.sectionOrder,
			promptProfile: narrow ? "narrow-worker" : undefined,
		};
	}

	/** Get cached PromptParts for serving prompt-sections API.
	 *  If not cached (e.g. dormant session), rebuild from session metadata. */
	getPromptParts(sessionId: string): PromptParts | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;

		let persisted: import("./session-store.js").PersistedSession | undefined;
		try { persisted = this.resolveStoreForId(session.id)?.get(session.id); }
		catch { persisted = undefined; }
		const effectiveGoalId = session.goalId ?? session.teamGoalId ?? persisted?.goalId ?? persisted?.teamGoalId;
		const sectionOrder = this.promptSectionOrderForGoal(effectiveGoalId, session.projectId ?? persisted?.projectId);
		const ownerProjectId = session.projectId ?? persisted?.projectId;
		const ownerProjectConfigStore = this.projectConfigStoreForPrompt(ownerProjectId);

		// Delegate task instructions are durable store data, not ordinary cached prompt
		// state. A provider hook can run after an early incomplete cache was created;
		// for delegates, always rebuild from persisted instructions/context so the
		// refresh path cannot overwrite the inspector snapshot with a task-less prompt.
		const isDelegate = !!(session.delegateOf || persisted?.delegateOf);
		if (isDelegate && persisted?.instructions?.trim()) {
			const parts = this.buildDelegatePromptParts({
				cwd: session.cwd,
				projectRoot: persisted.repoPath,
				instructions: persisted.instructions,
				context: persisted.context,
				allowedTools: session.allowedTools ?? persisted.allowedTools,
				sectionOrder,
			});
			parts.projectConfigStore = isNarrowDelegateAllowedTools(parts.allowedTools) ? undefined : ownerProjectConfigStore;
			parts.serverConfigStore = this.projectConfigStore;
			parts.dynamicContext = session.promptParts?.dynamicContext;
			if (this.toolManager && !parts.toolDocs) {
				parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), undefined, undefined, parts);
			}
			if (!parts.skillsCatalog) {
				parts.skillsCatalog = this.computeSkillsCatalog(
					parts.allowedTools,
					parts.projectRoot || parts.cwd,
					parts.projectConfigStore,
					session.projectId ?? persisted.projectId,
				);
			}
			if (parts.skillsCatalogBudget === undefined && this.preferencesStore) {
				const pref = this.preferencesStore.get("skillsCatalogBudget");
				if (typeof pref === "number" && Number.isFinite(pref)) parts.skillsCatalogBudget = pref;
			}
			session.promptParts = parts;
			return parts;
		}

		if (session.promptParts) return session.promptParts;

		// Rebuild on demand for dormant / restored sessions missing cached parts
		const assistantDef = session.assistantType ? getAssistantDef(session.assistantType) : undefined;
		let parts: PromptParts;

		if (assistantDef) {
			const assistantTemplate = this.resolveRolePromptTemplate("assistant", session.projectId);
			let assistantGoalSpec = "";
			if (assistantTemplate) {
				assistantGoalSpec = assistantTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(session.goalId || session.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;
			if (session.assistantType === "goal") {
				assistantGoalSpec = assistantGoalSpec.replace('{{AVAILABLE_WORKFLOWS}}', this._buildWorkflowList(session.projectId));
				// Inject re-attempt context if this is a re-attempt session
				const reattemptId = (this.resolveStoreForSession(session.id).get(session.id) as any)?.reattemptGoalId;
				if (reattemptId) {
					const origGoal = this.resolveGoal(reattemptId);
					if (origGoal) {
						assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal, this.prStatusStore!);
					}
				}
			}
			assistantGoalSpec = applyPromptConditionals(assistantGoalSpec, { subGoalsEnabled: this.isSubgoalsEnabled });
			parts = {
				// Assistant prompt reconstruction must include the base system prompt
				// so it survives respawn / rebuild paths (not just initial session-setup).
				baseSystemPromptPath: this.systemPromptPath,
				cwd: session.cwd,
				projectRoot: persisted?.repoPath,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: session.allowedTools,
				projectConfigStore: ownerProjectConfigStore,
				serverConfigStore: this.projectConfigStore,
				sectionOrder,
			};
		} else {
			const goal = session.goalId ? this.resolveGoal(session.goalId) : undefined;

			// Source the template via the field-level cascade (PR feature), then run
			// master's centralized placeholder substitution so create/restore can't drift.
			const tmpl = session.role && this.roleManager
				? this.resolveRolePromptTemplate(session.role, session.projectId)
				: undefined;
			const rolePrompt = resolveRolePrompt(tmpl ? { promptTemplate: tmpl } : undefined, {
				branch: goal?.branch,
				agentId: `${session.role}-${(session.goalId || session.id).slice(0, 8)}`,
				roleManager: this.roleManager,
				subGoalsEnabled: this.isSubgoalsEnabled,
			});
			const roleName = rolePrompt ? session.role : undefined;

			parts = {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: session.cwd,
				projectRoot: persisted?.repoPath,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec: goal?.spec,
				rolePrompt,
				roleName,
				allowedTools: session.allowedTools,
				projectConfigStore: ownerProjectConfigStore,
				serverConfigStore: this.projectConfigStore,
				sectionOrder,
				promptProfile: (session.nonInteractive ?? persisted?.nonInteractive) ? "reviewer" : undefined,
			};
		}

		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), undefined, undefined, parts);
		}
		if (!parts.skillsCatalog) {
			parts.skillsCatalog = this.computeSkillsCatalog(
				parts.allowedTools,
				parts.projectRoot || parts.cwd,
				parts.projectConfigStore,
				session.projectId ?? persisted?.projectId,
			);
		}
		if (parts.skillsCatalogBudget === undefined && this.preferencesStore) {
			const pref = this.preferencesStore.get("skillsCatalogBudget");
			if (typeof pref === "number" && Number.isFinite(pref)) parts.skillsCatalogBudget = pref;
		}

		// Cache for future calls
		session.promptParts = parts;
		return parts;
	}
}

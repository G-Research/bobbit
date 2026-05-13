/**
 * Reproducing test for the "role overrides ignored on spawn" bug.
 *
 * See the issue-analysis gate on goal goal-fix-role-o-d23e6c19. Summary:
 *
 *   SessionSetupPlan carries two parallel fields that name the same role:
 *     - plan.roleName  — used by the prompt + tool-policy resolvers
 *     - plan.role      — used by the model + thinking-level resolvers
 *
 *   team-manager.spawnRole, startTeam (team lead), and staff-manager all pass
 *   only `roleName: role` to createSession. So inside _resolveBridgeOptions:
 *
 *     ctx.resolveInitialModel(plan.role, plan.projectId)         // plan.role === undefined
 *     ctx.resolveInitialThinkingLevel(plan.role, plan.projectId) // plan.role === undefined
 *
 *   …and the resolvers fall straight through to default.sessionModel /
 *   default.sessionThinkingLevel, silently ignoring the role-level overrides.
 *
 * Why this test doesn't `import { resolveBridgeOptions } …`:
 *
 *   session-setup.ts transitively imports search-service → flex-store →
 *   `flexsearch`, whose CJS shape breaks tsx's ESM resolver (see the existing
 *   `tests/spawn-env.test.ts` for the same workaround). Instead, we extract
 *   the *exact* model/thinking-level resolution block from session-setup.ts
 *   at test time and execute it. The test always tracks the real production
 *   logic — when the fix lands, the extracted block changes, and the cases
 *   below flip from failing to passing.
 *
 * Acceptance criteria covered:
 *
 *   1. Worker role override (model + thinkingLevel) flows through to
 *      bridgeOptions when the caller passes `roleName` only.  [FAILS today]
 *   2. team-lead role override flows through the same way.    [FAILS today]
 *   3. Role with no overrides falls through to defaults.       [PASSES today]
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// ── Extract the production resolution block ──────────────────────────────

const SESSION_SETUP_SRC = readFileSync(
	path.join(process.cwd(), "src/server/agent/session-setup.ts"),
	"utf-8",
);

/**
 * Extract the model + thinking-level resolution block from
 * `_resolveBridgeOptions`. We grab everything between the "Pin model +
 * thinking level…" comment anchor and the closing "}" of the function, then
 * isolate the two if/else if chains.
 */
function extractResolverBlock(): string {
	// Anchor on a comment unique to the block under test.
	const startMarker = "// Pin model + thinking level at spawn time";
	const startIdx = SESSION_SETUP_SRC.indexOf(startMarker);
	assert.ok(startIdx >= 0, "anchor comment not found in session-setup.ts — has the file been refactored?");

	// Slice from the anchor to the closing `}` of the function body.  We
	// stop at the next `^}\n` at column zero — the function-level closing
	// brace.
	const tail = SESSION_SETUP_SRC.slice(startIdx);
	const endIdx = tail.indexOf("\n}\n");
	assert.ok(endIdx >= 0, "could not find end of _resolveBridgeOptions");
	return tail.slice(0, endIdx);
}

const RESOLVER_BLOCK = extractResolverBlock();

/**
 * Build a runnable replica of the resolver block.  `plan.bridgeOptions` must
 * already be populated by the caller (mirrors what `_resolveBridgeOptions`
 * does earlier in the function).
 */
type ResolverPlan = {
	role?: string;
	roleName?: string;
	projectId?: string;
	initialModel?: string;
	initialThinkingLevel?: string;
	skipAutoModel?: boolean;
	skipAutoThinking?: boolean;
	bridgeOptions: { initialModel?: string; initialThinkingLevel?: string };
};
type ResolverCtx = {
	resolveInitialModel: (role: string | undefined, projectId: string | undefined) => string | undefined;
	resolveInitialThinkingLevel: (role: string | undefined, projectId: string | undefined) => string | undefined;
};

const runResolver: (plan: ResolverPlan, ctx: ResolverCtx) => void = new Function(
	"plan", "ctx",
	RESOLVER_BLOCK,
) as any;

// ── Test fixtures ─────────────────────────────────────────────────────────

const DEFAULT_MODEL = "default-provider/default-model";
const DEFAULT_THINKING = "low";
const WORKER_ROLE_MODEL = "override-provider/worker-role-model";
const WORKER_ROLE_THINKING = "high";
const LEAD_ROLE_MODEL = "override-provider/team-lead-model";
const LEAD_ROLE_THINKING = "medium";

/**
 * Build a PipelineContext-shaped pair of resolvers backed by a fake role
 * store, mirroring the real `resolveInitialModel`/`resolveInitialThinkingLevel`
 * contract: when given a known role id with an override, return the override;
 * otherwise return the default.
 */
function makeResolvers(roleOverrides: Record<string, { model?: string; thinkingLevel?: string }>): ResolverCtx {
	return {
		resolveInitialModel: (role) => {
			if (role && roleOverrides[role]?.model) return roleOverrides[role].model;
			return DEFAULT_MODEL;
		},
		resolveInitialThinkingLevel: (role) => {
			if (role && roleOverrides[role]?.thinkingLevel) return roleOverrides[role].thinkingLevel;
			return DEFAULT_THINKING;
		},
	};
}

function makePlan(overrides: Partial<ResolverPlan>): ResolverPlan {
	return {
		bridgeOptions: {},
		...overrides,
	};
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("session-setup: role-keyed model/thinking-level overrides on spawn", () => {
	it("case 1: worker role with `roleName` only → model override flows through to bridgeOptions", () => {
		const ctx = makeResolvers({
			"qa-engineer": { model: WORKER_ROLE_MODEL, thinkingLevel: WORKER_ROLE_THINKING },
		});
		// team-manager.spawnRole shape: passes `roleName`, never `role`.
		const plan = makePlan({ roleName: "qa-engineer" });

		runResolver(plan, ctx);

		assert.equal(
			plan.bridgeOptions.initialModel,
			WORKER_ROLE_MODEL,
			"Worker role's `model` override must be applied at spawn time; got default instead — " +
			"bug: _resolveBridgeOptions reads `plan.role` (undefined) instead of falling back to `plan.roleName`.",
		);
		assert.equal(
			plan.bridgeOptions.initialThinkingLevel,
			WORKER_ROLE_THINKING,
			"Worker role's `thinkingLevel` override must be applied at spawn time; got default instead.",
		);
	});

	it("case 2: team-lead role with `roleName: 'team-lead'` only → override flows through", () => {
		const ctx = makeResolvers({
			"team-lead": { model: LEAD_ROLE_MODEL, thinkingLevel: LEAD_ROLE_THINKING },
		});
		// startTeam shape for the team-lead session.
		const plan = makePlan({ roleName: "team-lead" });

		runResolver(plan, ctx);

		assert.equal(
			plan.bridgeOptions.initialModel,
			LEAD_ROLE_MODEL,
			"team-lead role `model` override must be honored at team-lead spawn.",
		);
		assert.equal(
			plan.bridgeOptions.initialThinkingLevel,
			LEAD_ROLE_THINKING,
			"team-lead role `thinkingLevel` override must be honored at team-lead spawn.",
		);
	});

	it("case 3 (regression guard): role with no overrides → falls back to defaults", () => {
		// Role exists but defines no model/thinkingLevel overrides.
		const ctx = makeResolvers({ "qa-engineer": {} });
		const plan = makePlan({ roleName: "qa-engineer" });

		runResolver(plan, ctx);

		assert.equal(plan.bridgeOptions.initialModel, DEFAULT_MODEL);
		assert.equal(plan.bridgeOptions.initialThinkingLevel, DEFAULT_THINKING);
	});

	it("case 3b (regression guard): no roleName at all (plain session) → defaults", () => {
		const ctx = makeResolvers({});
		const plan = makePlan({});

		runResolver(plan, ctx);

		assert.equal(plan.bridgeOptions.initialModel, DEFAULT_MODEL);
		assert.equal(plan.bridgeOptions.initialThinkingLevel, DEFAULT_THINKING);
	});

	it("case 3c (regression guard): caller-supplied initialModel always wins", () => {
		const ctx = makeResolvers({
			"qa-engineer": { model: WORKER_ROLE_MODEL, thinkingLevel: WORKER_ROLE_THINKING },
		});
		const plan = makePlan({
			roleName: "qa-engineer",
			initialModel: "verification/pinned-model",
			initialThinkingLevel: "high",
		});

		runResolver(plan, ctx);

		assert.equal(plan.bridgeOptions.initialModel, "verification/pinned-model");
		assert.equal(plan.bridgeOptions.initialThinkingLevel, "high");
	});
});

// ── Source-level pin ──────────────────────────────────────────────────────

describe("session-setup: source contract for the fix", () => {
	it("source: model resolver call must fall back to plan.roleName when plan.role is unset", () => {
		// The fix introduces an `effectiveRoleId = plan.role ?? plan.roleName`
		// (or equivalent inline `plan.role ?? plan.roleName`) and passes that
		// to resolveInitialModel.  Pin the contract — fails before fix, passes
		// after.
		const ok =
			/resolveInitialModel\([^)]*plan\.role\s*\?\?\s*plan\.roleName/.test(SESSION_SETUP_SRC) ||
			/effectiveRoleId\s*=\s*plan\.role\s*\?\?\s*plan\.roleName[\s\S]{0,400}resolveInitialModel\(\s*effectiveRoleId/.test(SESSION_SETUP_SRC);
		assert.ok(
			ok,
			"resolveInitialModel must be called with `plan.role ?? plan.roleName` " +
			"(directly or via an effectiveRoleId local) so role-keyed model overrides " +
			"apply when callers pass only roleName. See the issue-analysis gate.",
		);
	});

	it("source: thinking-level resolver call must fall back to plan.roleName when plan.role is unset", () => {
		const ok =
			/resolveInitialThinkingLevel\([^)]*plan\.role\s*\?\?\s*plan\.roleName/.test(SESSION_SETUP_SRC) ||
			/effectiveRoleId\s*=\s*plan\.role\s*\?\?\s*plan\.roleName[\s\S]{0,400}resolveInitialThinkingLevel\(\s*effectiveRoleId/.test(SESSION_SETUP_SRC);
		assert.ok(
			ok,
			"resolveInitialThinkingLevel must be called with `plan.role ?? plan.roleName` " +
			"so role-keyed thinking-level overrides apply when callers pass only roleName.",
		);
	});
});

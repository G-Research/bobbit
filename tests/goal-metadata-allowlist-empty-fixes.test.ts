/**
 * Focused regression tests for the latest code-quality review findings on the
 * hierarchical goal-metadata goal. All three concern preserving an EXPLICIT
 * empty allowlist (`[]` = NO tools) as distinct from absent (`undefined` = fall
 * back to role/cascade defaults), plus using the EFFECTIVE goal for sandbox
 * wiring:
 *
 *   F1. session-manager restore/respawn path treated a persisted `allowedTools:
 *       []` as absent and fell back to role defaults. Both the restore decision
 *       (`restoreSession`) and `recomputeAllowedToolsForRestart` must preserve
 *       `[]`; only a missing/undefined value falls back.
 *   F2. session-setup `_resolveTools` conflated an explicit empty
 *       `plan.effectiveAllowedTools` with missing and fell back to the
 *       general/role allowlist. `[]` must survive first spawn so lower
 *       activation sees no tools.
 *   F3. session-setup sandbox wiring passed `plan.goalId` instead of the
 *       effective goal (`goalId ?? teamGoalId`) in BOTH sandbox paths, so
 *       sandboxed members/delegates (which carry only `teamGoalId`) lost goal
 *       token scoping and the container-worktree `goalProvisioned` dispatch.
 *
 * The deep functions are not cleanly importable (they reference `this` /
 * module-private state), so we extract the exact decision expressions/blocks
 * from source and evaluate them against controllable fakes — the same
 * extract-and-run pattern as tests/session-setup-role-accessory.test.ts — and
 * back them with source-contract pins.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SM_SRC = readFileSync(
	path.join(process.cwd(), "src/server/agent/session-manager.ts"),
	"utf-8",
);
const SS_SRC = readFileSync(
	path.join(process.cwd(), "src/server/agent/session-setup.ts"),
	"utf-8",
);

/** Extract a single source statement/expression matching `re` (first capture group). */
function extract(src: string, re: RegExp, what: string): string {
	const m = src.match(re);
	assert.ok(m && m[1] !== undefined, `could not extract ${what} — has the source shape changed?`);
	return m[1];
}

// ── F1. restore path preserves a persisted explicit empty allowlist ──────────

describe("session-manager restore preserves persisted explicit empty allowlist (F1)", () => {
	// The two assignments that decide whether a persisted `[]` is honoured.
	const persistedRhs = extract(
		SM_SRC,
		/const persistedAllowedTools = (Array\.isArray\(ps\.allowedTools\) \? ps\.allowedTools : undefined);/,
		"restore persistedAllowedTools RHS",
	);
	const evalPersisted = (allowedTools: unknown): unknown =>
		new Function("ps", `return ${persistedRhs};`)({ allowedTools });

	it("treats a persisted `[]` as an explicit (truthy) allowlist, not undefined", () => {
		const r = evalPersisted([]);
		assert.ok(Array.isArray(r), "persisted [] must stay an array (explicit no-tools)");
		assert.equal((r as unknown[]).length, 0);
	});

	it("treats a non-empty persisted allowlist as itself", () => {
		assert.deepEqual(evalPersisted(["read", "edit"]), ["read", "edit"]);
	});

	it("treats absent/non-array persisted allowlist as undefined (fall back)", () => {
		assert.equal(evalPersisted(undefined), undefined);
		assert.equal(evalPersisted("nope" as unknown), undefined);
	});

	// The final restore decision: keep filtered allowlist when there was an
	// explicit source OR the resolved allowlist is non-empty; only collapse a
	// genuinely-unrestricted (`[]`, no explicit source) session to undefined.
	const decisionExpr = extract(
		SM_SRC,
		/const restoredAllowedTools: EffectiveTool\[\] \| undefined =\s*\n\s*(\(hasExplicitAllowlist \|\| effectiveAllowed\.length > 0\) \? restoredFiltered : undefined);/,
		"restore restoredAllowedTools decision",
	);
	const evalDecision = (hasExplicitAllowlist: boolean, effectiveAllowed: unknown[], restoredFiltered: unknown): unknown =>
		new Function(
			"hasExplicitAllowlist",
			"effectiveAllowed",
			"restoredFiltered",
			`return ${decisionExpr};`,
		)(hasExplicitAllowlist, effectiveAllowed, restoredFiltered);

	it("explicit empty allowlist → stays [] (NO tools), never collapses to undefined", () => {
		// hasExplicitAllowlist=true and effectiveAllowed=[] (allowlist emptied) →
		// must keep restoredFiltered ([]), NOT undefined (which re-grants all).
		const r = evalDecision(true, [], []);
		assert.ok(Array.isArray(r) && (r as unknown[]).length === 0,
			"explicit-empty restore must remain [] (no tools)");
	});

	it("genuinely unrestricted (no explicit source, role resolves to []) → undefined (all tools)", () => {
		assert.equal(evalDecision(false, [], []), undefined);
	});

	it("non-empty resolved allowlist → keeps the filtered allowlist", () => {
		const filtered = [{ name: "read" }];
		assert.deepEqual(evalDecision(false, [{ name: "read" }], filtered), filtered);
	});
});

describe("recomputeAllowedToolsForRestart preserves persisted explicit empty allowlist (F1)", () => {
	const persistedRhs = extract(
		SM_SRC,
		/const persistedAllowedTools = (Array\.isArray\(ps\.allowedTools\) \? ps\.allowedTools : undefined);\n\t\tconst sessionGrants/,
		"recompute persistedAllowedTools RHS",
	);
	const evalPersisted = (allowedTools: unknown): unknown =>
		new Function("ps", `return ${persistedRhs};`)({ allowedTools });

	it("persisted `[]` is honoured (truthy) so grants layer onto an empty base", () => {
		const r = evalPersisted([]);
		assert.ok(Array.isArray(r) && (r as unknown[]).length === 0);
	});

	it("absent allowlist still falls back (undefined)", () => {
		assert.equal(evalPersisted(undefined), undefined);
	});

	it("source: neither restore site gates persisted allowlist on `.length > 0`", () => {
		assert.ok(
			!/Array\.isArray\(ps\.allowedTools\) && ps\.allowedTools\.length > 0/.test(SM_SRC),
			"a persisted explicit empty allowlist must not be treated as absent via `.length > 0`",
		);
	});
});

// ── F2. session-setup _resolveTools preserves explicit empty allowlist ───────

describe("session-setup _resolveTools preserves explicit empty allowlist (F2)", () => {
	/** Extract the _resolveTools body block, stripping the one TS type annotation. */
	function extractResolveBlock(): string {
		const start = SS_SRC.indexOf("let effectiveAllowedTools: EffectiveTool[] | undefined = plan.effectiveAllowedTools;");
		assert.ok(start >= 0, "could not find _resolveTools start");
		const endMarker = "plan.effectiveAllowedTools = effectiveAllowedTools;";
		const end = SS_SRC.indexOf(endMarker, start);
		assert.ok(end > start, "could not find _resolveTools end");
		return SS_SRC.slice(start, end + endMarker.length)
			.replace(": EffectiveTool[] | undefined", "");
	}
	const BLOCK = extractResolveBlock();
	// `computeEffectiveAllowedTools` is a free identifier; inject as a sentinel so
	// a wrongful fallback is observable.
	const runBlock = new Function("plan", "ctx", "computeEffectiveAllowedTools", BLOCK) as (
		plan: { effectiveAllowedTools?: unknown[]; roleName?: string; projectId?: string },
		ctx: unknown,
		ceat: (...a: unknown[]) => unknown[],
	) => void;

	const sentinel = [{ name: "ROLE_FALLBACK" }];
	const ctxWithRole = {
		roleManager: { getRole: (_n: string) => ({ name: "general" }) },
		toolManager: {},
		configCascade: undefined,
		groupPolicyStore: undefined,
		mcpManager: undefined,
	};

	it("explicit empty allowlist is preserved — NO fallback to role defaults", () => {
		const plan = { effectiveAllowedTools: [] as unknown[], roleName: "coder" };
		runBlock(plan, ctxWithRole, () => sentinel);
		assert.ok(Array.isArray(plan.effectiveAllowedTools) && plan.effectiveAllowedTools.length === 0,
			"explicit [] must survive first spawn so lower activation sees no tools");
	});

	it("undefined allowlist falls back to the role's resolved tools", () => {
		const plan: { effectiveAllowedTools?: unknown[]; roleName?: string } = { roleName: "coder" };
		runBlock(plan, ctxWithRole, () => sentinel);
		assert.deepEqual(plan.effectiveAllowedTools, sentinel);
	});

	it("non-empty allowlist is preserved untouched", () => {
		const keep = [{ name: "read" }];
		const plan = { effectiveAllowedTools: keep, roleName: "coder" };
		runBlock(plan, ctxWithRole, () => sentinel);
		assert.deepEqual(plan.effectiveAllowedTools, keep);
	});

	it("source: fallback guard is `=== undefined`, never `.length === 0`", () => {
		assert.ok(/if \(effectiveAllowedTools === undefined && ctx\.roleManager\)/.test(SS_SRC),
			"_resolveTools must only fall back when no allowlist was supplied");
		assert.ok(!/!effectiveAllowedTools \|\| effectiveAllowedTools\.length === 0/.test(SS_SRC),
			"explicit-empty allowlist must not trigger the role fallback");
	});
});

// ── F3. sandbox wiring uses the effective goal in BOTH paths ─────────────────

describe("session-setup sandbox wiring uses effective goal (F3)", () => {
	// The module-private effectiveGoalId() must be `goalId ?? teamGoalId`.
	const bodyExpr = extract(
		SS_SRC,
		/function effectiveGoalId\(plan: SessionSetupPlan\): string \| undefined \{\s*\n\s*return (plan\.goalId \?\? plan\.teamGoalId);/,
		"effectiveGoalId body",
	);
	const evalEffective = (goalId?: string, teamGoalId?: string): string | undefined =>
		new Function("plan", `return ${bodyExpr};`)({ goalId, teamGoalId });

	it("effectiveGoalId prefers own goalId, else teamGoalId", () => {
		assert.equal(evalEffective("g1", "t1"), "g1");
		assert.equal(evalEffective(undefined, "t1"), "t1");
		assert.equal(evalEffective(undefined, undefined), undefined);
	});

	it("source: BOTH applySandboxWiring call sites pass goalId: effectiveGoalId(plan)", () => {
		const wiringGoalArgs = SS_SRC.match(/applySandboxWiring\([\s\S]*?goalId: ([^,]+),/g) ?? [];
		assert.equal(wiringGoalArgs.length, 2, "expected exactly two applySandboxWiring goalId args in session-setup");
		for (const block of wiringGoalArgs) {
			assert.ok(/goalId: effectiveGoalId\(plan\),/.test(block),
				"sandbox wiring must scope by the effective goal, not plan.goalId");
		}
		assert.ok(!/goalId: plan\.goalId,\n\s*sandboxBranch: plan\.sandboxBranch/.test(SS_SRC),
			"no sandbox wiring site may pass the raw plan.goalId for goal/token scoping");
	});
});

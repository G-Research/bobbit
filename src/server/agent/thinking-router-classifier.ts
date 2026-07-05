// src/server/agent/thinking-router-classifier.ts
//
// CLF-W1b — the F14 deterministic thinking-level router: the Classifier
// Framework lane's first production `dispatchDecision` customer. See the
// Fable program's classifier-framework design note §7/§9
// ("Regex `ultrathink`→xhigh (0 tokens); else `ambiguous`→cheap model") and
// §10 Wave 1 ("deterministic-only ... no model-backed tiebreak yet").
//
// OBSERVE MODE (default, unchanged since W1b): `SessionManager.enqueuePrompt`
// consults this classifier and the resulting `Decision` is recorded into the
// transparency trace via `LifecycleHub.dispatchDecision` → `ContextTraceStore
// .appendDecision`, but nothing applies it — no `setThinkingLevel` call runs.
// The session's live thinking level is only ever changed by the pre-existing
// role/spawn-time resolution (`resolveInitialThinkingLevel`) and explicit user
// action (`set_thinking_level`, ws/handler.ts).
//
// CLF-W3 — APPLY MODE (`BOBBIT_CLF_THINKING_ROUTER=enforce`, see
// `isThinkingRouterApplyMode` below): `enqueuePrompt` calls
// `session.rpcClient.setThinkingLevel(choice)` with the classifier's exact
// `select`ed level, transiently for that turn only. The pre-apply effective
// level is remembered in live `SessionInfo` and restored on the next apply-mode
// prompt where the router does not select; neither the escalation nor the
// restore marker is persisted as `spawnPinnedThinkingLevel`. Three states mirror
// the tool-approve-heuristic pattern exactly (`isToolApproveEnforceMode`):
// absent or any value other than the literal string `"enforce"` (including
// `"observe"`) stays observe-only, byte-identical to W1b.
//
// PRECEDENCE (pinned invariant — the classifier must lose to any config a
// human already committed to): apply mode never fires when
// `SessionManager.resolveRoleThinkingLevel(session)` returns a role-level
// override, or when `session.thinkingLevelUserPinned` is true (set only by
// the explicit `set_thinking_level` ws action — never by spawn-time default
// resolution). See `SessionManager.canApplyThinkingRouterDecision`. An
// `abstain` never calls `setThinkingLevel` regardless of mode — there is
// nothing to apply.
//
// Deterministic-only discipline: the design doc names "heuristic tiers" as a
// Wave-1 aspiration but gives no concrete deterministic rule for prompt-shape
// tiers beyond the `ultrathink` keyword itself — inventing thresholds here
// (e.g. by prompt length) would be exactly the "ambiguity guessing" the
// design's cascade discipline (§7) reserves for a model tiebreak, which this
// wave explicitly does not have. So the rule table below is intentionally
// small: match a hard-override keyword → `select`, otherwise `abstain` and
// let the pre-hook default win (design doc §4).
//
// S7 (extension-seam audit) — PACK-DECLARED RULE OVERRIDE. The audit asked for
// this classifier's RULES table to become pack-authored rather than baked into
// core. Two mechanisms were considered:
//
//   1. A REAL pack-provided classifier, dispatched per-prompt through
//      `moduleHost.invoke` — the path `decision-types.ts`'s own
//      `DecisionClassifier` doc comment names as the eventual Wave 1(b)
//      adapter. REJECTED for this seam: `ModuleHost.invoke`
//      (module-host-worker.ts) spawns a brand-new `worker_threads.Worker` per
//      call — tens of milliseconds of process/isolate startup — and
//      `enqueuePrompt` is the hottest path in the agent runtime (one consult
//      per submitted user prompt). Paying a worker spawn on every prompt to
//      evaluate two regexes would be a severe, user-visible latency
//      regression for zero behavioural benefit in the default case.
//   2. SEAM ONLY (chosen): the built-in `RULES` table below stays the
//      DEFAULT, synchronous, in-process rule set. A pack MAY declare a
//      `kind: "selector"` provider named `THINKING_ROUTER_RULES_PROVIDER_ID`
//      (`providers/<id>.yaml`, the same declarative contribution surface
//      panels/entrypoints/routes already use) whose flat `config.rules` is a
//      plain regex→level table. `registerThinkingRouterClassifier` reads it
//      ONCE, synchronously, via `PackContributionRegistry.listProviders`
//      (documented synchronous — no moduleHost, no I/O) at gateway
//      construction, and bakes the EFFECTIVE table into a closure. The
//      classifier's per-prompt `evaluate()` is therefore still a pure,
//      zero-await regex loop — byte-identical per-prompt cost whether or not
//      a pack overrides the table. The provider's `module`/`hooks: []` fields
//      exist only to satisfy the shared provider-contribution schema; with an
//      empty `hooks` list the module is never invoked by
//      `LifecycleHub.dispatch()` or any goal hook — it carries no code, only
//      declarative config. See `resolveEffectiveThinkingRules` below.
//
// Malformed/missing pack config FAILS OPEN to the built-in `RULES` table
// (never leaves the router without a rule table); a single malformed rule
// ENTRY inside an otherwise-valid table is dropped individually so one typo
// doesn't discard a pack author's whole table. See `parseThinkingRouterRuleOverride`.
import { isKnownThinkingLevel, type ThinkingLevel } from "../../shared/thinking-levels.js";
import type { Decision, DecisionClassifier, DecisionDispatchCtx, DecisionPoint } from "./decision-types.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import type { ProviderContribution } from "./pack-contributions.js";

/** The (point, kind) pair this router is registered at. Exported so the
 *  production call site (`SessionManager.enqueuePrompt`) and the
 *  registration call site (`registerThinkingRouterClassifier`, wired at
 *  gateway construction in `server.ts`) can never drift apart into a silent
 *  mismatch — a typo in either place fails `npm run check`, not a test. */
export const THINKING_ROUTER_POINT: DecisionPoint = "user-prompt-submit";
export const THINKING_ROUTER_KIND = "thinking";
export const THINKING_ROUTER_CLASSIFIER_ID = "builtin.thinking-router";

/** Argument shape passed to the thinking-router classifier's `evaluate()`. */
export interface ThinkingRouterArg {
	/** The user's verbatim submitted text (NOT the model-expanded dispatch
	 *  text produced for skill/file-mention expansions) — the keyword rules
	 *  describe user intent, not model-facing content. */
	text: string;
}

interface ThinkingRule {
	id: string;
	pattern: RegExp;
	level: ThinkingLevel;
}

// F14 finding + F14-ultrathink-override treat `ultrathink` and `think harder`
// as equivalent hard-override markers for the same (highest) tier — see
// PRIOR-CLAIMS.md F14-ultrathink-override ("detect an `ultrathink`/`think
// harder` marker ... apply xhigh for that turn only"). Word-boundary regex so
// e.g. "ultrathinking" or "rethink harder" don't false-positive.
const RULES: readonly ThinkingRule[] = [
	{ id: "ultrathink", pattern: /\bultrathink\b/i, level: "xhigh" },
	{ id: "think-harder", pattern: /\bthink harder\b/i, level: "xhigh" },
];

/** Pure rule-table matcher — zero tokens, zero I/O, fully synchronous. Shared
 *  by `classifyThinkingLevel` (always the built-in `RULES`) and by any
 *  pack-override-aware classifier `resolveEffectiveThinkingRules` builds, so
 *  match semantics (first-match-wins, in table order) can never drift between
 *  the two. */
function matchThinkingRules(text: string, rules: readonly ThinkingRule[]): Decision<ThinkingLevel> {
	for (const rule of rules) {
		if (rule.pattern.test(text)) {
			return { kind: "select", choice: rule.level, confidence: 1, rationale: `matched deterministic rule '${rule.id}'` };
		}
	}
	return { kind: "abstain" };
}

/**
 * Pure rule-table function against the BUILT-IN `RULES` table — zero tokens,
 * zero I/O, fully synchronous. Exported directly so the rule table itself is
 * unit-testable without standing up a `LifecycleHub`/`DecisionClassifier`
 * wrapper. Always uses the built-in defaults, regardless of any pack
 * override — see `resolveEffectiveThinkingRules` for the override-aware path
 * `registerThinkingRouterClassifier` actually registers.
 */
export function classifyThinkingLevel(text: string): Decision<ThinkingLevel> {
	return matchThinkingRules(text, RULES);
}

function isThinkingRouterArg(value: unknown): value is ThinkingRouterArg {
	return !!value && typeof value === "object" && typeof (value as ThinkingRouterArg).text === "string";
}

/** Builds a `DecisionClassifier` bound to a specific (already-resolved) rule
 *  table. Used both for the built-in singleton below (`RULES`) and for the
 *  pack-override-effective table `registerThinkingRouterClassifier` resolves
 *  at construction. A malformed/missing `arg` (defensive — `dispatchDecision`'s
 *  `arg` is untyped `unknown`) abstains rather than throwing, matching
 *  `isDecision`'s "malformed → treated as abstain" discipline elsewhere in the
 *  seam. */
function createThinkingRouterClassifier(rules: readonly ThinkingRule[]): DecisionClassifier<ThinkingLevel> {
	return {
		id: THINKING_ROUTER_CLASSIFIER_ID,
		evaluate(_ctx: DecisionDispatchCtx, arg: unknown): Decision<ThinkingLevel> {
			if (!isThinkingRouterArg(arg)) return { kind: "abstain" };
			return matchThinkingRules(arg.text, rules);
		},
	};
}

/**
 * The built-in deterministic classifier — CLF-W1b's Decision-seam customer at
 * `(user-prompt-submit, thinking)`, bound to the built-in `RULES` table.
 * Byte-identical to the pre-S7 implementation (same id, same evaluate
 * semantics) — `registerThinkingRouterClassifier` uses this singleton
 * directly whenever no pack override resolves.
 */
export const thinkingRouterClassifier: DecisionClassifier<ThinkingLevel> = createThinkingRouterClassifier(RULES);

// --- S7: pack-declared rule-table override -------------------------------

/** Provider `id`/`kind` convention a pack uses to declare a thinking-router
 *  rule-table override. See this file's header for the full contract. */
export const THINKING_ROUTER_RULES_PROVIDER_ID = "thinking-router-rules";
export const THINKING_ROUTER_RULES_PROVIDER_KIND = "selector";

/** Minimal read surface `registerThinkingRouterClassifier` needs from a
 *  `PackContributionRegistry` — structurally satisfied by the real class
 *  (`listProviders(projectId): ProviderContribution[]`) without this file
 *  importing it, keeping this leaf module's dependency graph small. */
export interface ThinkingRouterRuleRegistry {
	listProviders(projectId: string | undefined): ProviderContribution[];
}

/** Only `i` (case-insensitive) and `s` (dotAll) are accepted. `g`/`y` are
 *  refused: a rule's `RegExp` is reused across every `evaluate()` call via
 *  `.test()`, and a global/sticky flag makes `.test()` stateful (mutates
 *  `lastIndex` between calls), which would silently corrupt matching on the
 *  SECOND prompt onward. This is a correctness guard, not a style choice. */
const ALLOWED_RULE_FLAGS_RE = /^[is]*$/;

interface ParsedRuleTable {
	mode: "extend" | "override";
	rules: ThinkingRule[];
}

function warnOverride(msg: string): void {
	console.warn(`[thinking-router-classifier] pack rule override: ${msg}`);
}

/** Validate+compile a single pack-declared rule entry. Returns `undefined`
 *  (dropped, warned) for any structural problem — a bad entry never throws
 *  and never disables the rest of an otherwise-valid table. */
function parseRuleEntry(raw: unknown): ThinkingRule | undefined {
	if (!raw || typeof raw !== "object") {
		warnOverride("rule entry is not a mapping; dropping");
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	const id = r.id;
	if (typeof id !== "string" || id.length === 0) {
		warnOverride("rule entry missing a non-empty string 'id'; dropping");
		return undefined;
	}
	const patternSrc = r.pattern;
	if (typeof patternSrc !== "string" || patternSrc.length === 0) {
		warnOverride(`rule '${id}' missing a non-empty string 'pattern'; dropping`);
		return undefined;
	}
	const flagsRaw = r.flags;
	if (flagsRaw !== undefined && (typeof flagsRaw !== "string" || !ALLOWED_RULE_FLAGS_RE.test(flagsRaw))) {
		warnOverride(`rule '${id}' has unsupported flags ${JSON.stringify(flagsRaw)} (only 'i'/'s' allowed); dropping`);
		return undefined;
	}
	const level = isKnownThinkingLevel(r.level);
	if (!level) {
		warnOverride(`rule '${id}' has unknown/missing 'level' ${JSON.stringify(r.level)}; dropping`);
		return undefined;
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(patternSrc, typeof flagsRaw === "string" ? flagsRaw : undefined);
	} catch (err) {
		warnOverride(`rule '${id}' has an invalid regex pattern ${JSON.stringify(patternSrc)}: ${err instanceof Error ? err.message : String(err)}; dropping`);
		return undefined;
	}
	return { id, pattern, level };
}

/**
 * Parse+validate a pack-declared thinking-router rule-table override from a
 * `THINKING_ROUTER_RULES_PROVIDER_ID` provider's flat `config`. Returns
 * `undefined` — FAIL OPEN to the built-in `RULES` table — when the config
 * isn't a mapping, `rules` isn't a non-empty array, or every entry in it is
 * individually malformed. A partially-valid table (some good entries, some
 * bad) keeps only the good entries rather than discarding the whole table.
 * Exported for direct unit testing of the validation contract.
 */
export function parseThinkingRouterRuleOverride(config: unknown): ParsedRuleTable | undefined {
	if (!config || typeof config !== "object") return undefined;
	const c = config as Record<string, unknown>;
	const mode: "extend" | "override" = c.mode === "override" ? "override" : "extend"; // unknown/absent ⇒ extend (safer: additive, never silently drops the built-ins)
	const rulesRaw = c.rules;
	if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) return undefined;
	const rules: ThinkingRule[] = [];
	const seenIds = new Set<string>();
	for (const entry of rulesRaw) {
		const parsed = parseRuleEntry(entry);
		if (!parsed) continue;
		if (seenIds.has(parsed.id)) {
			warnOverride(`duplicate rule id '${parsed.id}'; keeping the first occurrence`);
			continue;
		}
		seenIds.add(parsed.id);
		rules.push(parsed);
	}
	if (rules.length === 0) return undefined; // every entry malformed ⇒ fail open to defaults
	return { mode, rules };
}

/**
 * Resolve the EFFECTIVE thinking-router rule table at construction time:
 * the built-in `RULES`, optionally overridden/extended by a pack-declared
 * `THINKING_ROUTER_RULES_PROVIDER_ID` provider. `registry.listProviders` is
 * documented synchronous (no moduleHost, no I/O — see
 * `PackContributionRegistry.listProviders`'s own doc comment), so this
 * entire resolution is zero-await; the returned table is baked into a
 * classifier closure ONCE and never re-consulted per prompt (see this file's
 * header for why a per-prompt pack dispatch was rejected).
 *
 * Fails open to `RULES` (returns the exact same array reference) for: no
 * registry passed, no matching provider, a `listProviders` throw, or a
 * config that `parseThinkingRouterRuleOverride` can't extract anything
 * usable from.
 */
export function resolveEffectiveThinkingRules(registry?: ThinkingRouterRuleRegistry): readonly ThinkingRule[] {
	if (!registry) return RULES;
	let providers: ProviderContribution[];
	try {
		providers = registry.listProviders(undefined);
	} catch (err) {
		console.warn(`[thinking-router-classifier] listProviders failed (non-fatal, using built-in defaults): ${err instanceof Error ? err.message : String(err)}`);
		return RULES;
	}
	const override = providers.find((p) => p.kind === THINKING_ROUTER_RULES_PROVIDER_KIND && p.id === THINKING_ROUTER_RULES_PROVIDER_ID);
	if (!override) return RULES;
	const parsed = parseThinkingRouterRuleOverride(override.config);
	if (!parsed) return RULES;
	return parsed.mode === "override" ? parsed.rules : [...parsed.rules, ...RULES];
}

/** Reads the flag LIVE (not cached at module load) so tests can flip it
 *  in-process without re-importing — same idiom as
 *  `isToolApproveEnforceMode()` (tool-approve-classifier.ts). Default is
 *  OBSERVE: any value other than the exact string "enforce" (including
 *  unset, or the explicit "observe") stays observe-only, byte-identical to
 *  CLF-W1b. See this file's header for the precedence rules apply mode must
 *  still honor. */
export function isThinkingRouterApplyMode(): boolean {
	return process.env.BOBBIT_CLF_THINKING_ROUTER === "enforce";
}

/**
 * Registers the built-in thinking router at `(user-prompt-submit, thinking)`.
 * Called ONCE at gateway construction (`server.ts`, right after
 * `sessionManager.lifecycleHub` is created) — NOT from `SessionManager`'s own
 * constructor, since `lifecycleHub` is an optional field assigned by the
 * caller after construction (see `SessionManager.lifecycleHub?: LifecycleHub`).
 *
 * Registering here (rather than merely `allowDecisionPoint`) means the pair
 * always has a real classifier attached, so `dispatchDecision`'s "throw on
 * unregistered (point,kind)" guard never fires for this pair in production —
 * per that method's own doc comment, a real call site must decide fail-open
 * vs fail-closed before relying on the allow-list throw; this router doesn't
 * rely on it at all, since it registers a classifier instead of a bare
 * allow-list entry.
 *
 * Returns the unregister function (mirrors `registerDecisionClassifier`) for
 * symmetry/tests; production code never calls it.
 *
 * `registry` (S7, optional) — when passed, `resolveEffectiveThinkingRules`
 * consults it ONCE, synchronously, for a pack-declared rule-table override
 * (see this file's header). Omitted (every pre-S7 call site: `server.ts`
 * passes it; the three existing test files that call this with one argument
 * do not) ⇒ the built-in `thinkingRouterClassifier` singleton is registered
 * verbatim — byte-identical to pre-S7 behaviour, same object, same id, same
 * evaluate semantics.
 */
export function registerThinkingRouterClassifier(hub: LifecycleHub, registry?: ThinkingRouterRuleRegistry): () => void {
	const rules = resolveEffectiveThinkingRules(registry);
	const classifier = rules === RULES ? thinkingRouterClassifier : createThinkingRouterClassifier(rules);
	return hub.registerDecisionClassifier<ThinkingLevel>(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, classifier);
}

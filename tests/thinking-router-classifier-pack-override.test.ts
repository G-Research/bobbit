// S7 (extension-seam audit) — pins the pack-declared rule-table override seam
// for the F14 thinking router. See thinking-router-classifier.ts's header for
// the full "why not a moduleHost-dispatched classifier" rationale: the
// override is resolved ONCE, synchronously, at `registerThinkingRouterClassifier`
// construction time (via `PackContributionRegistry.listProviders`, documented
// synchronous — no worker, no I/O), so the registered classifier's per-prompt
// `evaluate()` stays a pure zero-await regex loop regardless of whether a pack
// overrides the table.
//
// Companion to tests/thinking-router-classifier.test.ts (built-in RULES,
// unchanged) and tests/thinking-router-trace-integration.test.ts (real
// LifecycleHub wiring, no override) — neither of those files is touched here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextTraceStore } from "../src/server/agent/context-trace-store.ts";
import { LifecycleHub } from "../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../src/server/agent/pack-contributions.ts";
import {
	registerThinkingRouterClassifier,
	resolveEffectiveThinkingRules,
	parseThinkingRouterRuleOverride,
	classifyThinkingLevel,
	THINKING_ROUTER_POINT,
	THINKING_ROUTER_KIND,
	THINKING_ROUTER_RULES_PROVIDER_ID,
	THINKING_ROUTER_RULES_PROVIDER_KIND,
	type ThinkingRouterRuleRegistry,
} from "../src/server/agent/thinking-router-classifier.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "thinking-router-pack-override-")));
}

let seq = 0;
function makeProvider(overrides: Partial<ProviderContribution> = {}, tmp = "/tmp"): ProviderContribution {
	const id = overrides.id ?? THINKING_ROUTER_RULES_PROVIDER_ID;
	return {
		id,
		kind: overrides.kind ?? (THINKING_ROUTER_RULES_PROVIDER_KIND as ProviderContribution["kind"]),
		module: overrides.module ?? "./noop.mjs",
		hooks: overrides.hooks ?? [],
		budget: overrides.budget ?? { maxTokens: 400, timeoutMs: 1000 },
		config: overrides.config,
		listName: overrides.listName ?? `p-${seq++}`,
		sourceFile: overrides.sourceFile ?? path.join(tmp, "providers", `${id}.yaml`),
		packRoot: overrides.packRoot ?? tmp,
	};
}

function fakeRegistry(providers: ProviderContribution[]): ThinkingRouterRuleRegistry {
	return { listProviders: () => providers };
}

function throwingRegistry(): ThinkingRouterRuleRegistry {
	return {
		listProviders() {
			throw new Error("boom");
		},
	};
}

describe("parseThinkingRouterRuleOverride (S7 validation contract)", () => {
	it("returns undefined for a non-object config", () => {
		assert.equal(parseThinkingRouterRuleOverride(undefined), undefined);
		assert.equal(parseThinkingRouterRuleOverride(null), undefined);
		assert.equal(parseThinkingRouterRuleOverride("nope"), undefined);
	});

	it("returns undefined when 'rules' is missing, not an array, or empty", () => {
		assert.equal(parseThinkingRouterRuleOverride({}), undefined);
		assert.equal(parseThinkingRouterRuleOverride({ rules: "nope" }), undefined);
		assert.equal(parseThinkingRouterRuleOverride({ rules: [] }), undefined);
	});

	it("parses a valid single-rule table, defaulting mode to 'extend'", () => {
		const parsed = parseThinkingRouterRuleOverride({
			rules: [{ id: "yolo", pattern: "\\byolo\\b", flags: "i", level: "high" }],
		});
		assert.ok(parsed);
		assert.equal(parsed!.mode, "extend");
		assert.equal(parsed!.rules.length, 1);
		assert.equal(parsed!.rules[0].id, "yolo");
		assert.equal(parsed!.rules[0].level, "high");
		assert.equal(parsed!.rules[0].pattern.test("please YOLO this"), true);
	});

	it("honors an explicit mode: override", () => {
		const parsed = parseThinkingRouterRuleOverride({
			mode: "override",
			rules: [{ id: "yolo", pattern: "yolo", level: "high" }],
		});
		assert.equal(parsed!.mode, "override");
	});

	it("treats an unknown mode value as 'extend' (fail-open on the mode field only)", () => {
		const parsed = parseThinkingRouterRuleOverride({
			mode: "wipe-everything",
			rules: [{ id: "yolo", pattern: "yolo", level: "high" }],
		});
		assert.equal(parsed!.mode, "extend");
	});

	it("drops an individual entry missing 'id' but keeps the rest of the table", () => {
		const parsed = parseThinkingRouterRuleOverride({
			rules: [{ pattern: "yolo", level: "high" }, { id: "good", pattern: "good", level: "medium" }],
		});
		assert.equal(parsed!.rules.length, 1);
		assert.equal(parsed!.rules[0].id, "good");
	});

	it("drops an entry with an unknown thinking level", () => {
		const parsed = parseThinkingRouterRuleOverride({
			rules: [{ id: "bad-level", pattern: "x", level: "ultra-mega" }, { id: "ok", pattern: "y", level: "low" }],
		});
		assert.equal(parsed!.rules.length, 1);
		assert.equal(parsed!.rules[0].id, "ok");
	});

	it("drops an entry with an invalid regex pattern", () => {
		const parsed = parseThinkingRouterRuleOverride({
			rules: [{ id: "bad-regex", pattern: "(unclosed", level: "high" }, { id: "ok", pattern: "y", level: "low" }],
		});
		assert.equal(parsed!.rules.length, 1);
		assert.equal(parsed!.rules[0].id, "ok");
	});

	it("drops an entry with a disallowed regex flag (e.g. 'g' — stateful .test() lastIndex)", () => {
		const parsed = parseThinkingRouterRuleOverride({
			rules: [{ id: "global-flag", pattern: "x", flags: "g", level: "high" }, { id: "ok", pattern: "y", level: "low" }],
		});
		assert.equal(parsed!.rules.length, 1);
		assert.equal(parsed!.rules[0].id, "ok");
	});

	it("drops a duplicate rule id, keeping the first occurrence", () => {
		const parsed = parseThinkingRouterRuleOverride({
			rules: [
				{ id: "dup", pattern: "first", level: "high" },
				{ id: "dup", pattern: "second", level: "low" },
			],
		});
		assert.equal(parsed!.rules.length, 1);
		assert.equal(parsed!.rules[0].level, "high");
	});

	it("fails open to undefined (whole table) when every entry is malformed", () => {
		const parsed = parseThinkingRouterRuleOverride({
			rules: [{ pattern: "no-id", level: "high" }, { id: "bad-level-only", pattern: "x", level: "nope" }],
		});
		assert.equal(parsed, undefined);
	});
});

describe("resolveEffectiveThinkingRules (S7 construction-time resolution)", () => {
	it("returns the built-in defaults when no registry is passed", () => {
		const rules = resolveEffectiveThinkingRules();
		assert.equal(rules.length, 2);
		assert.equal(rules[0].id, "ultrathink");
	});

	it("returns the built-in defaults when the registry has no matching provider", () => {
		const rules = resolveEffectiveThinkingRules(fakeRegistry([]));
		assert.equal(rules.length, 2);
	});

	it("returns the built-in defaults when a provider matches the id but not the 'selector' kind", () => {
		const rules = resolveEffectiveThinkingRules(
			fakeRegistry([makeProvider({ kind: "generic", config: { rules: [{ id: "x", pattern: "x", level: "xhigh" }] } })]),
		);
		assert.equal(rules.length, 2);
	});

	it("returns the built-in defaults when listProviders throws (non-fatal, fail-open)", () => {
		const rules = resolveEffectiveThinkingRules(throwingRegistry());
		assert.equal(rules.length, 2);
	});

	it("returns the built-in defaults when the matching provider's config is malformed", () => {
		const rules = resolveEffectiveThinkingRules(fakeRegistry([makeProvider({ config: { rules: "nope" } })]));
		assert.equal(rules.length, 2);
	});

	it("extends the built-in table (pack rules checked first) in default/'extend' mode", () => {
		const rules = resolveEffectiveThinkingRules(
			fakeRegistry([makeProvider({ config: { rules: [{ id: "yolo", pattern: "\\byolo\\b", flags: "i", level: "low" }] } })]),
		);
		assert.equal(rules.length, 3);
		assert.equal(rules[0].id, "yolo");
		assert.equal(rules[1].id, "ultrathink");
		assert.equal(rules[2].id, "think-harder");
	});

	it("replaces the built-in table entirely in 'override' mode", () => {
		const rules = resolveEffectiveThinkingRules(
			fakeRegistry([makeProvider({ config: { mode: "override", rules: [{ id: "yolo", pattern: "\\byolo\\b", level: "low" }] } })]),
		);
		assert.equal(rules.length, 1);
		assert.equal(rules[0].id, "yolo");
	});
});

describe("registerThinkingRouterClassifier (S7 end-to-end via LifecycleHub.dispatchDecision)", () => {
	function makeHub(tmp: string, providers: ProviderContribution[] = []): InstanceType<typeof LifecycleHub> {
		return new LifecycleHub({
			registry: { listProviders: () => providers } as any,
			moduleHost: {} as any,
			trace: new ContextTraceStore(path.join(tmp, "never-written-trace-dir")),
			gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
		});
	}

	it("custom pack rule loads and routes: a pack-declared keyword selects the pack's level", async () => {
		const tmp = tmpDir();
		const hub = makeHub(tmp);
		registerThinkingRouterClassifier(
			hub,
			fakeRegistry([makeProvider({ config: { rules: [{ id: "yolo", pattern: "\\byolo\\b", flags: "i", level: "low" }] } }, tmp)]),
		);
		const decision = await hub.dispatchDecision(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, { sessionId: "s1", cwd: tmp }, { text: "let's YOLO this change" });
		assert.deepEqual(decision, { kind: "select", choice: "low", confidence: 1, rationale: "matched deterministic rule 'yolo'" });
	});

	it("custom pack rule in extend mode does not break the still-present built-in 'ultrathink' rule", async () => {
		const tmp = tmpDir();
		const hub = makeHub(tmp);
		registerThinkingRouterClassifier(
			hub,
			fakeRegistry([makeProvider({ config: { rules: [{ id: "yolo", pattern: "\\byolo\\b", level: "low" }] } }, tmp)]),
		);
		const decision = await hub.dispatchDecision(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, { sessionId: "s1", cwd: tmp }, { text: "ultrathink about this" });
		assert.equal(decision.kind, "select");
		assert.equal((decision as { choice: string }).choice, "xhigh");
	});

	it("override mode fully replaces the table: 'ultrathink' no longer selects", async () => {
		const tmp = tmpDir();
		const hub = makeHub(tmp);
		registerThinkingRouterClassifier(
			hub,
			fakeRegistry([makeProvider({ config: { mode: "override", rules: [{ id: "yolo", pattern: "\\byolo\\b", level: "low" }] } }, tmp)]),
		);
		const decision = await hub.dispatchDecision(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, { sessionId: "s1", cwd: tmp }, { text: "ultrathink about this" });
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("a malformed pack rule table fails open to byte-identical built-in behaviour", async () => {
		const tmp = tmpDir();
		const hub = makeHub(tmp);
		registerThinkingRouterClassifier(hub, fakeRegistry([makeProvider({ config: { rules: [{ id: "no-pattern", level: "high" }] } }, tmp)]));
		const ultrathink = await hub.dispatchDecision(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, { sessionId: "s1", cwd: tmp }, { text: "ultrathink please" });
		assert.deepEqual(ultrathink, classifyThinkingLevel("ultrathink please"));
		const ordinary = await hub.dispatchDecision(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, { sessionId: "s2", cwd: tmp }, { text: "fix this typo" });
		assert.deepEqual(ordinary, classifyThinkingLevel("fix this typo"));
	});

	it("registering with no registry argument stays byte-identical to the pre-S7 built-in classifier", async () => {
		const tmp = tmpDir();
		const hub = makeHub(tmp);
		registerThinkingRouterClassifier(hub);
		const decision = await hub.dispatchDecision(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, { sessionId: "s1", cwd: tmp }, { text: "ultrathink about this" });
		assert.deepEqual(decision, classifyThinkingLevel("ultrathink about this"));
	});
});

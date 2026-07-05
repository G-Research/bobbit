/**
 * Eligibility-signal lane pin: `_resolveTools` (Step 3 of the session-setup
 * pipeline) must thread the session's RESOLVED tool allowlist onto
 * `plan.bridgeOptions.allowedTools`, so `createSessionBridge` ->
 * `isInProcessBridgeEligible` (`in-process-bridge-eligibility.ts`) can derive
 * read-only-ness from it via `isReadOnlyToolPolicy` instead of requiring every
 * caller to remember an opt-in `readOnly` flag (docs/design/
 * in-process-bridge-spike.md "Sizing results (2026-07-05)").
 *
 * Uses the same extract-and-run pattern as
 * `tests/session-setup-role-accessory.test.ts` (avoids importing the whole
 * session-setup.ts module, which pulls in a flexsearch CJS import that breaks
 * tsx's ESM resolver).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SESSION_SETUP_SRC = readFileSync(
	path.join(process.cwd(), "src/server/agent/session-setup.ts"),
	"utf-8",
);

describe("session-setup: source contract for the eligibility-signal fix", () => {
	it("source: _resolveTools threads the resolved allowlist onto bridgeOptions.allowedTools", () => {
		const ok = /plan\.bridgeOptions\.allowedTools\s*=\s*effectiveAllowedTools\?\.map\(t\s*=>\s*t\.name\)/.test(SESSION_SETUP_SRC);
		assert.ok(
			ok,
			"_resolveTools must assign `plan.bridgeOptions.allowedTools = effectiveAllowedTools?.map(t => t.name)` " +
			"so isInProcessBridgeEligible can derive read-only-ness from the session's actual resolved tools.",
		);
	});

	it("source: the assignment happens AFTER plan.effectiveAllowedTools is set (ordering matters)", () => {
		const effectiveIdx = SESSION_SETUP_SRC.indexOf("plan.effectiveAllowedTools = effectiveAllowedTools;");
		const bridgeIdx = SESSION_SETUP_SRC.indexOf("plan.bridgeOptions.allowedTools = effectiveAllowedTools?.map(t => t.name);");
		assert.ok(effectiveIdx >= 0 && bridgeIdx >= 0, "both anchors must exist in session-setup.ts");
		assert.ok(bridgeIdx > effectiveIdx, "bridgeOptions.allowedTools must be assigned after effectiveAllowedTools is resolved");
	});
});

/**
 * Functional pin: extract the exact block that resolves + threads
 * effectiveAllowedTools and run it against controllable fakes, proving the
 * data actually flows from a role's resolved tools to `bridgeOptions.allowedTools`
 * — not just that the source string is present.
 */
function extractResolveToolsCore(): string {
	const startMarker = "function _resolveTools(plan: SessionSetupPlan, ctx: PipelineContext): void {";
	const startIdx = SESSION_SETUP_SRC.indexOf(startMarker);
	assert.ok(startIdx >= 0, "anchor for _resolveTools not found — has it been renamed?");
	const braceStart = SESSION_SETUP_SRC.indexOf("{", startIdx);
	let depth = 0;
	let end = -1;
	for (let i = braceStart; i < SESSION_SETUP_SRC.length; i++) {
		const ch = SESSION_SETUP_SRC[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) { end = i + 1; break; }
		}
	}
	assert.ok(end > 0, "could not balance _resolveTools's braces");
	// Body only (strip outer braces) so we can splice it into our own function.
	const body = SESSION_SETUP_SRC.slice(braceStart + 1, end - 1);
	// The body has TS-only syntax (type annotations on locals, e.g.
	// `let effectiveAllowedTools: EffectiveTool[] | undefined = ...`), which
	// `new Function` can't parse as raw JS. Strip types via the real TS
	// compiler (already a project dependency) rather than a fragile regex.
	return ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

const RESOLVE_TOOLS_BODY = extractResolveToolsCore();

type Plan = {
	effectiveAllowedTools?: { name: string }[];
	bridgeOptions: { allowedTools?: string[] };
	roleName?: string;
	role?: string;
	projectId?: string;
	cwd?: string;
	accessory?: string;
};

// Bare identifiers inside the extracted body (computeEffectiveAllowedTools,
// lookupRole, scopedToolContext) are injected as parameters so the block runs
// against controllable fakes instead of the real, heavier implementations.
const runResolveTools: (
	plan: Plan,
	ctx: { roleManager?: unknown; toolManager?: unknown; groupPolicyStore?: unknown; mcpManager?: unknown },
	computeEffectiveAllowedTools: (...args: unknown[]) => { name: string }[] | undefined,
	lookupRole: (name: string, plan: Plan, ctx: unknown) => unknown,
	scopedToolContext: (...args: unknown[]) => unknown,
) => void = new Function(
	"plan", "ctx", "computeEffectiveAllowedTools", "lookupRole", "scopedToolContext",
	RESOLVE_TOOLS_BODY,
) as any;

describe("session-setup: _resolveTools threads resolved tools onto bridgeOptions (functional)", () => {
	it("a read-only-shaped role's resolved tools flow through to bridgeOptions.allowedTools", () => {
		const plan: Plan = { bridgeOptions: {}, roleName: "pr-reviewer" };
		runResolveTools(
			plan,
			{ roleManager: {}, toolManager: {} },
			() => [{ name: "readonly_bash" }, { name: "read_pr_walkthrough_bundle" }],
			() => ({ accessory: "review" }),
			() => undefined,
		);
		assert.deepEqual(plan.bridgeOptions.allowedTools, ["readonly_bash", "read_pr_walkthrough_bundle"]);
	});

	it("a mutating-tool-shaped role's resolved tools also flow through unchanged (classification happens downstream)", () => {
		const plan: Plan = { bridgeOptions: {}, roleName: "code-reviewer" };
		runResolveTools(
			plan,
			{ roleManager: {}, toolManager: {} },
			() => [{ name: "read" }, { name: "bash" }, { name: "write" }],
			() => ({ accessory: "magnifier" }),
			() => undefined,
		);
		assert.deepEqual(plan.bridgeOptions.allowedTools, ["read", "bash", "write"]);
	});

	it("an already-explicit plan.effectiveAllowedTools (no role fallback) still threads through", () => {
		const plan: Plan = { bridgeOptions: {}, effectiveAllowedTools: [{ name: "read" }, { name: "grep" }] };
		runResolveTools(plan, {}, () => undefined, () => undefined, () => undefined);
		assert.deepEqual(plan.bridgeOptions.allowedTools, ["read", "grep"]);
	});

	it("no role, no explicit tools -> bridgeOptions.allowedTools is undefined (unrestricted, fails closed downstream)", () => {
		const plan: Plan = { bridgeOptions: {} };
		runResolveTools(plan, {}, () => undefined, () => undefined, () => undefined);
		assert.equal(plan.bridgeOptions.allowedTools, undefined);
	});
});

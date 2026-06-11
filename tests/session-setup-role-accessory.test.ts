/**
 * GAP 1 pin: generic role-accessory application in session-setup `_resolveTools`.
 *
 * `OrchestrationCore.spawn` (full lifecycle) threads `roleName` into
 * `createSession`, but the spawn caller does NOT pass an `accessory`. Before the
 * fix the resolved session had no accessory, so a role-carrying child (e.g. the
 * host.agents `pr-reviewer` reviewer, whose role declares `accessory: review`)
 * showed no sidebar accessory — failing the acceptance criterion "visible in the
 * sidebar, review accessory".
 *
 * The fix applies the resolved role's `accessory` when none was explicitly passed
 * and the role's accessory is not "none". This is GENERIC (not pr-walkthrough
 * specific). This test extracts the accessory-application block from
 * session-setup.ts and runs it in isolation (the same extract-and-run pattern as
 * `tests/session-setup-role-override.test.ts`, which avoids the flexsearch CJS
 * import that breaks tsx's ESM resolver), plus a source-level contract pin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const SESSION_SETUP_SRC = readFileSync(
	path.join(process.cwd(), "src/server/agent/session-setup.ts"),
	"utf-8",
);

/** Extract the accessory-application block (anchored on its unique comment). */
function extractAccessoryBlock(): string {
	const startMarker = "// Generic role-accessory application.";
	const startIdx = SESSION_SETUP_SRC.indexOf(startMarker);
	assert.ok(startIdx >= 0, "anchor comment not found in session-setup.ts — has the block been renamed?");
	const ifIdx = SESSION_SETUP_SRC.indexOf("if (!plan.accessory", startIdx);
	assert.ok(ifIdx >= 0, "accessory if-block not found after the anchor comment");

	// Balance braces from the first `{` of the if to its matching close.
	const braceStart = SESSION_SETUP_SRC.indexOf("{", ifIdx);
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
	assert.ok(end > 0, "could not balance the accessory if-block braces");
	return SESSION_SETUP_SRC.slice(ifIdx, end);
}

const ACCESSORY_BLOCK = extractAccessoryBlock();

type Plan = { accessory?: string; roleName?: string; role?: string };
type Role = { accessory?: string } | undefined;

// `lookupRole(name, plan, ctx)` is a bare identifier inside the block; inject it
// as a parameter so the block runs against a controllable fake.
const runBlock: (plan: Plan, ctx: unknown, lookupRole: (name: string, plan: Plan, ctx: unknown) => Role) => void =
	new Function("plan", "ctx", "lookupRole", ACCESSORY_BLOCK) as any;

function makeLookup(roles: Record<string, Role>): (name: string) => Role {
	return (name: string) => roles[name];
}

describe("session-setup: generic role-accessory application (GAP 1)", () => {
	it("applies the role's accessory when none was explicitly passed (pr-reviewer → review)", () => {
		const plan: Plan = { roleName: "pr-reviewer" };
		const lookup = makeLookup({ "pr-reviewer": { accessory: "review" } });
		runBlock(plan, {}, (name) => lookup(name));
		assert.equal(plan.accessory, "review");
	});

	it("falls back to plan.role when plan.roleName is unset", () => {
		const plan: Plan = { role: "code-reviewer" };
		const lookup = makeLookup({ "code-reviewer": { accessory: "magnifier" } });
		runBlock(plan, {}, (name) => lookup(name));
		assert.equal(plan.accessory, "magnifier");
	});

	it("does NOT override an explicitly-passed accessory", () => {
		const plan: Plan = { roleName: "pr-reviewer", accessory: "crown" };
		const lookup = makeLookup({ "pr-reviewer": { accessory: "review" } });
		runBlock(plan, {}, (name) => lookup(name));
		assert.equal(plan.accessory, "crown");
	});

	it("treats a role accessory of 'none' as no accessory (general role)", () => {
		const plan: Plan = { roleName: "general" };
		const lookup = makeLookup({ "general": { accessory: "none" } });
		runBlock(plan, {}, (name) => lookup(name));
		assert.equal(plan.accessory, undefined);
	});

	it("leaves accessory undefined when there is no role at all", () => {
		const plan: Plan = {};
		runBlock(plan, {}, () => undefined);
		assert.equal(plan.accessory, undefined);
	});
});

describe("session-setup: source contract for the accessory fix", () => {
	it("source: _resolveTools assigns plan.accessory from the resolved role", () => {
		const ok = /plan\.accessory\s*=\s*resolvedRole\.accessory/.test(SESSION_SETUP_SRC);
		assert.ok(
			ok,
			"_resolveTools must assign `plan.accessory = resolvedRole.accessory` so a role-carrying " +
			"spawn (e.g. the host.agents pr-reviewer child) surfaces its accessory in the sidebar.",
		);
	});
});

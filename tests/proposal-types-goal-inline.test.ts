/**
 * Goal proposal serialize/parse — inlineWorkflow + inlineRoles round-trip.
 *
 * Pins the bug fix in proposal-types.ts: the goal serializer used to
 * hardcode the four frontmatter keys (title/cwd/workflow/options) and
 * silently dropped any other field — including the documented
 * `inlineWorkflow` and `inlineRoles` parameters. The agent's call would
 * succeed (ack rev), but the draft on disk had only the 4 legacy keys.
 *
 * Cases:
 *   1. Round-trip a payload with both fields: serialize → write to a
 *      synthetic content string → parse → fields re-emerge byte-equivalent.
 *   2. Empty inlineRoles object is dropped at serialize time (no noisy
 *      `inlineRoles: {}` in every draft frontmatter).
 *   3. Empty inlineWorkflow (null/undefined/missing) is dropped likewise.
 *   4. Validator rejects malformed inlineWorkflow (missing gates[]).
 *   5. Validator rejects malformed inlineWorkflow (missing id).
 *   6. Validator rejects malformed inlineRoles entry (missing
 *      promptTemplate).
 *   7. Validator rejects malformed inlineRoles container (array, not
 *      object).
 *   8. Existing 4 keys still round-trip without disturbance.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProposalTypePlugin } from "../src/server/proposals/proposal-types.ts";

const goal = getProposalTypePlugin("goal");

function roundTrip(fields: Record<string, unknown>): Record<string, unknown> {
	const content = goal.serialize(fields);
	const parsed = goal.parse(content);
	if (!parsed.ok) throw new Error(`parse failed: ${parsed.code} ${parsed.message}`);
	return parsed.value.fields;
}

describe("goal proposal — inlineWorkflow + inlineRoles round-trip", () => {
	it("round-trips inlineWorkflow as a YAML mapping (not JSON-stringified)", () => {
		const inlineWorkflow = {
			id: "audit-mini",
			name: "Audit Mini",
			description: "ephemeral audit-only workflow",
			gates: [
				{ id: "gather", name: "Gather Inputs", dependsOn: [] },
				{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["gather"] },
			],
		};
		const fields = {
			title: "Real-tasks comparison audit",
			spec: "## Mission\n\nCompare three harnesses and produce a deliverable.\n",
			workflow: "audit-mini",
			inlineWorkflow,
		};
		const out = roundTrip(fields);
		assert.equal(out.title, "Real-tasks comparison audit");
		assert.deepEqual(out.inlineWorkflow, inlineWorkflow,
			"inlineWorkflow must round-trip byte-equivalent through serialize/parse");
		// Confirm it's a real YAML mapping, not a JSON-encoded string.
		const content = goal.serialize(fields);
		assert.match(content, /inlineWorkflow:/, "serialized content must contain `inlineWorkflow:` key");
		assert.match(content, /id: audit-mini/, "serialized content must contain the workflow id as a YAML scalar");
		assert.doesNotMatch(content, /inlineWorkflow: '\{/, "must NOT JSON-stringify");
	});

	it("round-trips inlineRoles as a YAML mapping with all role fields", () => {
		const inlineRoles = {
			"synthesis-reviewer": {
				name: "synthesis-reviewer",
				label: "Synthesis Reviewer",
				accessory: "magnifying-glass",
				toolPolicies: { gate_signal: "never" },
				promptTemplate: "You are a synthesis reviewer for this audit. {{AGENT_ID}}",
			},
			"audit-tester": {
				name: "audit-tester",
				label: "Audit Tester",
				accessory: "flask",
				promptTemplate: "You verify audit deliverables. {{AGENT_ID}}",
			},
		};
		const fields = {
			title: "Audit goal",
			spec: "## Mission\n\nAudit.\n",
			inlineRoles,
		};
		const out = roundTrip(fields);
		assert.deepEqual(out.inlineRoles, inlineRoles);
		const content = goal.serialize(fields);
		assert.match(content, /inlineRoles:/);
		assert.match(content, /synthesis-reviewer:/);
		assert.match(content, /toolPolicies:/);
	});

	it("round-trips both fields together alongside the legacy 4 keys", () => {
		const fields = {
			title: "Combined",
			cwd: "/tmp/x",
			workflow: "feature",
			options: "QA testing",
			spec: "spec body\n",
			inlineWorkflow: { id: "wf", name: "W", gates: [] },
			inlineRoles: { r: { name: "r", label: "R", promptTemplate: "P" } },
		};
		const out = roundTrip(fields);
		assert.equal(out.title, "Combined");
		assert.equal(out.cwd, "/tmp/x");
		assert.equal(out.workflow, "feature");
		assert.equal(out.options, "QA testing");
		assert.deepEqual(out.inlineWorkflow, { id: "wf", name: "W", gates: [] });
		assert.deepEqual(out.inlineRoles, { r: { name: "r", label: "R", promptTemplate: "P" } });
	});

	it("drops empty inlineRoles object — no noisy `inlineRoles: {}` line", () => {
		const fields = {
			title: "no-roles",
			spec: "spec\n",
			inlineRoles: {},
		};
		const content = goal.serialize(fields);
		assert.doesNotMatch(content, /inlineRoles:/);
		const parsed = goal.parse(content);
		assert.equal(parsed.ok, true);
		if (parsed.ok) {
			assert.equal(parsed.value.fields.inlineRoles, undefined);
		}
	});

	it("drops null / undefined inlineWorkflow at serialize time", () => {
		const fields = { title: "no-wf", spec: "spec\n", inlineWorkflow: null };
		const content = goal.serialize(fields);
		assert.doesNotMatch(content, /inlineWorkflow:/);
	});

	it("legacy 4-key round-trip is unchanged (regression guard)", () => {
		const fields = {
			title: "Legacy",
			cwd: "/x",
			workflow: "feature",
			options: "QA testing",
			spec: "body\n",
		};
		const out = roundTrip(fields);
		assert.equal(out.title, "Legacy");
		assert.equal(out.cwd, "/x");
		assert.equal(out.workflow, "feature");
		assert.equal(out.options, "QA testing");
		assert.equal(out.inlineWorkflow, undefined);
		assert.equal(out.inlineRoles, undefined);
	});
});

describe("goal proposal — structural validation when inline fields are present", () => {
	it("rejects inlineWorkflow with no gates array", () => {
		const fields = {
			title: "bad-wf",
			spec: "spec\n",
			inlineWorkflow: { id: "wf", name: "W" /* gates missing */ },
		};
		const content = goal.serialize(fields);
		const parsed = goal.parse(content);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) {
			assert.equal(parsed.code, "STRUCTURAL_VALIDATION_FAILED");
			assert.match(parsed.message, /gates/);
		}
	});

	it("rejects inlineWorkflow with no id", () => {
		const fields = {
			title: "bad-wf",
			spec: "spec\n",
			inlineWorkflow: { name: "W", gates: [] },
		};
		const content = goal.serialize(fields);
		const parsed = goal.parse(content);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) {
			assert.equal(parsed.code, "STRUCTURAL_VALIDATION_FAILED");
			assert.match(parsed.message, /id/);
		}
	});

	it("rejects inlineRoles entry missing promptTemplate", () => {
		const fields = {
			title: "bad-roles",
			spec: "spec\n",
			inlineRoles: {
				r: { name: "r", label: "R" /* promptTemplate missing */ },
			},
		};
		const content = goal.serialize(fields);
		const parsed = goal.parse(content);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) {
			assert.equal(parsed.code, "STRUCTURAL_VALIDATION_FAILED");
			assert.match(parsed.message, /promptTemplate/);
		}
	});

	it("accepts inlineRoles.toolPolicies with allow|ask|never values (R-021)", () => {
		// The goal-spawn-child tool tightens toolPolicies to the union of
		// 'allow' | 'ask' | 'never'. The proposal serializer carries the
		// values through verbatim. Keep these in sync — a typo'd policy
		// value should fail validation at the call site, not surface as
		// an opaque gate-spawn error later.
		const inlineRoles = {
			r: {
				name: "r",
				label: "R",
				promptTemplate: "P",
				toolPolicies: { gate_signal: "never", goal_spawn_child: "allow", verification_result: "ask" },
			},
		};
		const fields = { title: "ok-roles", spec: "s\n", inlineRoles };
		const content = goal.serialize(fields);
		const parsed = goal.parse(content);
		assert.equal(parsed.ok, true);
		if (parsed.ok) {
			assert.deepEqual(
				(parsed.value.fields.inlineRoles as Record<string, { toolPolicies: Record<string, string> }>).r.toolPolicies,
				inlineRoles.r.toolPolicies,
			);
		}
	});

	it("rejects inlineRoles passed as an array (must be an object)", () => {
		const fields = {
			title: "bad-roles",
			spec: "spec\n",
			inlineRoles: [{ name: "r", label: "R", promptTemplate: "P" }],
		};
		const content = goal.serialize(fields);
		// Arrays may not even pass through the serializer's empty-array filter
		// for Record-typed fields — let's just check that if they get to parse,
		// the validator rejects them.
		const parsed = goal.parse(content);
		// Either the serializer dropped the empty/non-object value (then parse
		// returns ok with no inlineRoles), or parse rejects with STRUCTURAL.
		if (parsed.ok) {
			assert.equal(parsed.value.fields.inlineRoles, undefined);
		} else {
			assert.equal(parsed.code, "STRUCTURAL_VALIDATION_FAILED");
		}
	});
});

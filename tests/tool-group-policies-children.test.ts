/**
 * Unit test: defaults/tool-group-policies.yaml exposes the `Children` group
 * with the `ask` policy by default.
 *
 * Motivation (security hardening, F4): the nested-goals tool group exposes
 * `goal_spawn_child`, `goal_plan_propose`, `goal_merge_child`, etc. — actions
 * with side-effects on the goal tree. The global default must be `ask` so a
 * user is prompted before any role outside team-lead can use them. Team-leads
 * opt back in via their role-level `toolPolicies: { Children: allow }`.
 *
 * If somebody flips this to `allow` or removes the entry entirely, this test
 * fails fast.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import yaml from "yaml";

describe("defaults/tool-group-policies.yaml — Children group", () => {
	const file = path.resolve(
		path.dirname(new URL(import.meta.url).pathname),
		"..",
		"defaults",
		"tool-group-policies.yaml",
	);
	const text = fs.readFileSync(file, "utf-8");
	const parsed = yaml.parse(text) as Record<string, unknown>;

	it("declares Children: ask", () => {
		assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed),
			"defaults/tool-group-policies.yaml must parse as a mapping");
		assert.equal(parsed.Children, "ask",
			"Children group must default to 'ask' (security hardening — nested-goals tools must prompt the user)");
	});

	it("Children policy value is one of the documented enum values", () => {
		// The full enum is allow / ask / never. We assert membership so a future
		// typo (e.g. `Children: asks`) is caught even if someone weakens the
		// security default by accident.
		assert.ok(["allow", "ask", "never"].includes(String(parsed.Children)),
			`Children policy must be allow|ask|never, got ${parsed.Children}`);
	});
});

describe("defaults/roles/team-lead.yaml — Children opt-in", () => {
	const file = path.resolve(
		path.dirname(new URL(import.meta.url).pathname),
		"..",
		"defaults",
		"roles",
		"team-lead.yaml",
	);
	const text = fs.readFileSync(file, "utf-8");
	const parsed = yaml.parse(text) as Record<string, unknown>;

	it("toolPolicies has Children: allow", () => {
		const tp = parsed.toolPolicies as Record<string, unknown> | undefined;
		assert.ok(tp && typeof tp === "object" && !Array.isArray(tp),
			"team-lead.yaml must declare a toolPolicies mapping");
		assert.equal(tp.Children, "allow",
			"team-lead must opt in to the Children tool group (Children: allow) so it can spawn nested goals without prompting the user");
	});
});

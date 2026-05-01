/**
 * Unit test enforcing the per-role `gate_signal` tool-policy invariant.
 *
 * Design: only the team lead may signal gates; all spawnable contributor roles
 * (coder, test-engineer, reviewer family, architect, spec-auditor, qa-tester,
 * docs-writer) MUST declare `toolPolicies.gate_signal: never` so the
 * tool-guard extension hard-blocks the call at runtime. Assistant-style and
 * out-of-scope roles (general, assistant, ux-designer) are exempt.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const ROLES_DIR = path.resolve(import.meta.dirname, "..", "defaults", "roles");

const CONTRIBUTOR_ROLES = [
	"coder",
	"test-engineer",
	"reviewer",
	"code-reviewer",
	"security-reviewer",
	"architect",
	"spec-auditor",
	"qa-tester",
	"docs-writer",
];

const EXEMPT_ROLES = ["general", "assistant", "ux-designer"];

function loadRole(name: string): { toolPolicies?: Record<string, string> } {
	const file = path.join(ROLES_DIR, `${name}.yaml`);
	const text = fs.readFileSync(file, "utf-8");
	return YAML.parse(text) as { toolPolicies?: Record<string, string> };
}

describe("role gate_signal policy invariant", () => {
	it("team-lead has gate_signal: always-allow", () => {
		const role = loadRole("team-lead");
		assert.equal(role.toolPolicies?.gate_signal, "always-allow");
	});

	for (const name of CONTRIBUTOR_ROLES) {
		it(`${name} has gate_signal: never`, () => {
			const role = loadRole(name);
			assert.equal(
				role.toolPolicies?.gate_signal,
				"never",
				`${name}.yaml must declare toolPolicies.gate_signal: never (only team-lead may signal gates)`,
			);
		});
	}

	for (const name of EXEMPT_ROLES) {
		it(`${name} is exempt (no gate_signal policy required)`, () => {
			// Just confirm the file parses; no assertion on gate_signal.
			const role = loadRole(name);
			assert.ok(role);
		});
	}
});

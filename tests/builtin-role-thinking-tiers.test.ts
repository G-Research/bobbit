/**
 * Pins per-role `thinkingLevel` tiering on the built-in role YAMLs
 * (`defaults/roles/*.yaml`), loaded via the exact same `parseRolesDir` the
 * server uses (`BuiltinConfigProvider` / config cascade lowest layer, see
 * src/server/agent/builtin-config.ts).
 *
 * Finding F5 (Fable audit): the resolution mechanism for a role-level
 * `thinkingLevel` override was fully plumbed (role-store.ts validation,
 * config-cascade.ts field resolution, session-manager.ts
 * `resolveInitialThinkingLevel`, verification-harness.ts
 * `resolveRoleForGoal` + its gate/QA/verifier spawn call sites) but inert —
 * no built-in role set the field, so every spawned role agent silently ran
 * at the flat global default ("medium", session-manager.ts
 * `resolveInitialThinkingLevel`).
 *
 * This test pins the tier assignment so a future role edit can't silently
 * drop it back to flat/uniform:
 *   - high   — team-lead, architect, and the highest-stakes/deepest-reasoning
 *              reviewer roles (security-reviewer, spec-auditor, bug-hunter).
 *   - medium — mechanical-but-technical execution/review roles (coder,
 *              reviewer, code-reviewer, test-engineer, qa-tester). This
 *              matches the current implicit global default, but is made
 *              explicit here so it survives a future default change.
 *   - low    — docs-writer (purely mechanical: prose/doc edits only, no
 *              production logic changes allowed by its own role prompt).
 * Roles intentionally left without a tier (assistant, general, ux-designer)
 * are asserted `undefined` so the omission itself is pinned, not just an
 * oversight.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { parseRolesDir } = await import("../src/server/agent/builtin-config.ts");

const ROLES_DIR = path.resolve(import.meta.dirname, "..", "defaults", "roles");

function thinkingLevelOf(roles: ReturnType<typeof parseRolesDir>, name: string): string | undefined {
	const role = roles.find(r => r.name === name);
	assert.ok(role, `expected built-in role "${name}" to exist`);
	return role!.thinkingLevel;
}

describe("built-in role thinkingLevel tiering (F5)", () => {
	const roles = parseRolesDir(ROLES_DIR);

	it("tiers high-stakes strategic/reviewer roles at high", () => {
		for (const name of ["team-lead", "architect", "security-reviewer", "spec-auditor", "bug-hunter"]) {
			assert.equal(thinkingLevelOf(roles, name), "high", `${name} should be thinkingLevel: high`);
		}
	});

	it("tiers mechanical-but-technical execution/review roles at medium", () => {
		for (const name of ["coder", "reviewer", "code-reviewer", "test-engineer", "qa-tester"]) {
			assert.equal(thinkingLevelOf(roles, name), "medium", `${name} should be thinkingLevel: medium`);
		}
	});

	it("tiers the purely-mechanical docs-writer role at low", () => {
		assert.equal(thinkingLevelOf(roles, "docs-writer"), "low");
	});

	it("leaves non-team-orchestration roles without an explicit tier (implicit medium default)", () => {
		for (const name of ["assistant", "general", "ux-designer"]) {
			assert.equal(thinkingLevelOf(roles, name), undefined, `${name} should not set thinkingLevel`);
		}
	});

	it("only ever emits values accepted by the canonical thinking-level enum", async () => {
		const { VALID_THINKING_LEVELS } = await import("../src/server/agent/role-store.ts");
		for (const role of roles) {
			if (role.thinkingLevel === undefined) continue;
			assert.ok(
				(VALID_THINKING_LEVELS as readonly string[]).includes(role.thinkingLevel),
				`${role.name}.thinkingLevel "${role.thinkingLevel}" must be one of ${VALID_THINKING_LEVELS.join(", ")}`,
			);
		}
	});
});

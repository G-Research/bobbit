/**
 * Pins the deliberate decision NOT to ship a per-role `model` default on any
 * built-in role YAML (`defaults/roles/*.yaml`), loaded via the exact same
 * `parseRolesDir` the server uses (`BuiltinConfigProvider` / config cascade
 * lowest layer, see src/server/agent/builtin-config.ts).
 *
 * Finding VER-02 (Fable audit): the per-role model override mechanism is
 * fully plumbed end-to-end — `role.model` field (role-store.ts), config
 * cascade resolution (config-cascade.ts `resolveRoleModel`),
 * session-manager.ts `resolveRoleModel`/`tryAutoSelectModel`, and the three
 * verification-harness.ts spawn sites (reviewer/QA/legacy sub-session) all
 * already read and bind `role.model` — but, like thinkingLevel before F5, no
 * built-in role sets the field, so every role's session model resolution
 * falls through to `default.sessionModel` / AI-Gateway discovery exactly as
 * it always has.
 *
 * Unlike thinkingLevel (F5, pinned by tests/builtin-role-thinking-tiers.
 * test.ts), this test pins that the built-in roles STAY that way. A role
 * model failure is a hard contract: `applyModelString`/`tryAutoSelectModel`
 * throw on setModel failure or read-back mismatch, and only fall back to
 * `default.sessionModel` when the operator has separately opted into
 * `allowSessionModelFallback` (off by default, see
 * docs/session-model-fallback.md and tests/controlled-model-fallback.
 * test.ts). Shipping a hardcoded literal `<provider>/<modelId>` default on a
 * built-in role would therefore hard-fail every spawn of that role on any
 * install where that exact model isn't configured/available — the opposite
 * of graceful degradation. The recommended per-role model tiers are
 * documented as operator guidance (apply via the role manager's Model
 * controls, not shipped as a default) in
 * docs/design/per-role-model-overrides.md and docs/internals.md.
 *
 * If a future change wants to ship a literal model default on a built-in
 * role, update this test deliberately alongside evidence that the
 * availability-fallback risk above has been addressed (e.g. a symbolic tier
 * that only picks among a gateway's actually-discovered models, the way
 * `selectAigwModelForRoleTier` already does for the AI-Gateway auto-select
 * path — see tests/model-utils.test.ts and finding F5-model-aigw).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { parseRolesDir } = await import("../src/server/agent/builtin-config.ts");

const ROLES_DIR = path.resolve(import.meta.dirname, "..", "defaults", "roles");

describe("built-in role model tiering (VER-02)", () => {
	const roles = parseRolesDir(ROLES_DIR);

	it("loads at least one built-in role (sanity check on the fixture path)", () => {
		assert.ok(roles.length > 0, "expected parseRolesDir to find built-in role YAMLs");
	});

	it("no built-in role ships a literal model default — every role inherits default.sessionModel/default.reviewModel", () => {
		for (const role of roles) {
			assert.equal(
				role.model,
				undefined,
				`role "${role.name}" must not set a literal model default (VER-02: hardcoding an unavailable ` +
					`model would hard-fail every spawn of that role — see docs/session-model-fallback.md)`,
			);
		}
	});
});

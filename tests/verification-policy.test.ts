/**
 * S8 seam, V0 — pure-function tests for the typed `VerificationPolicy`
 * loader/merge pair (see docs/design/verification-policy-seam.md §2/§5).
 *
 * Pins:
 *   1. `resolveVerificationPolicy` round-trips the shipped
 *      `defaults/verification-policy.yaml` byte-identical to
 *      `DEFAULT_VERIFICATION_POLICY` (today's hardcoded values).
 *   2. Malformed/partial/missing input fails closed to
 *      `DEFAULT_VERIFICATION_POLICY` field-by-field — never throws, never
 *      produces a partially-undefined policy.
 *   3. `mergeVerificationPolicyRaw` composes cascade layers per-field
 *      (last-write-wins) with `gateRoles` merged by key, not replaced
 *      wholesale.
 *
 * Runs via `npm run test:unit` (Node test runner, no I/O beyond reading the
 * shipped defaults YAML fixture).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
	DEFAULT_VERIFICATION_POLICY,
	resolveVerificationPolicy,
	mergeVerificationPolicyRaw,
	type VerificationPolicy,
} from "../src/server/agent/verification-logic.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

describe("resolveVerificationPolicy — defaults round-trip", () => {
	it("the shipped defaults/verification-policy.yaml resolves byte-identical to DEFAULT_VERIFICATION_POLICY", () => {
		const raw = fs.readFileSync(path.join(REPO_ROOT, "defaults", "verification-policy.yaml"), "utf-8");
		const resolved = resolveVerificationPolicy(parse(raw));
		assert.deepEqual(resolved, DEFAULT_VERIFICATION_POLICY);
	});

	it("undefined/null/non-object input falls back to DEFAULT_VERIFICATION_POLICY", () => {
		assert.deepEqual(resolveVerificationPolicy(undefined), DEFAULT_VERIFICATION_POLICY);
		assert.deepEqual(resolveVerificationPolicy(null), DEFAULT_VERIFICATION_POLICY);
		assert.deepEqual(resolveVerificationPolicy("garbage"), DEFAULT_VERIFICATION_POLICY);
		assert.deepEqual(resolveVerificationPolicy(42), DEFAULT_VERIFICATION_POLICY);
		assert.deepEqual(resolveVerificationPolicy([]), DEFAULT_VERIFICATION_POLICY);
	});

	it("an empty object falls back to every DEFAULT_VERIFICATION_POLICY field", () => {
		assert.deepEqual(resolveVerificationPolicy({}), DEFAULT_VERIFICATION_POLICY);
	});

	it("returned objects don't alias DEFAULT_VERIFICATION_POLICY's mutable gateRoles", () => {
		const resolved = resolveVerificationPolicy({});
		resolved.gateRoles["ready-to-merge"]!.requiredBuiltins!.push("mutated");
		assert.deepEqual(DEFAULT_VERIFICATION_POLICY.gateRoles["ready-to-merge"]!.requiredBuiltins, [
			"branch", "baseBranch", "master", "cwd", "goal_spec", "commit",
		]);
	});
});

describe("resolveVerificationPolicy — fails closed field-by-field", () => {
	it("gateCacheDefault: only the literal 'content' is honored; anything else falls back to 'sha'", () => {
		assert.equal(resolveVerificationPolicy({ gateCacheDefault: "content" }).gateCacheDefault, "content");
		assert.equal(resolveVerificationPolicy({ gateCacheDefault: "sha" }).gateCacheDefault, "sha");
		assert.equal(resolveVerificationPolicy({ gateCacheDefault: "Content" }).gateCacheDefault, "sha");
		assert.equal(resolveVerificationPolicy({ gateCacheDefault: "garbage" }).gateCacheDefault, "sha");
		assert.equal(resolveVerificationPolicy({ gateCacheDefault: 1 }).gateCacheDefault, "sha");
	});

	it("parallelReviewsDefault: only a real boolean overrides; anything else falls back to true", () => {
		assert.equal(resolveVerificationPolicy({ parallelReviewsDefault: false }).parallelReviewsDefault, false);
		assert.equal(resolveVerificationPolicy({ parallelReviewsDefault: true }).parallelReviewsDefault, true);
		assert.equal(resolveVerificationPolicy({ parallelReviewsDefault: "false" }).parallelReviewsDefault, true);
		assert.equal(resolveVerificationPolicy({ parallelReviewsDefault: 0 }).parallelReviewsDefault, true);
	});

	it("gateRoles: a non-object value falls back to the default map", () => {
		assert.deepEqual(resolveVerificationPolicy({ gateRoles: "garbage" }).gateRoles, DEFAULT_VERIFICATION_POLICY.gateRoles);
		assert.deepEqual(resolveVerificationPolicy({ gateRoles: [] }).gateRoles, DEFAULT_VERIFICATION_POLICY.gateRoles);
		assert.deepEqual(resolveVerificationPolicy({ gateRoles: null }).gateRoles, DEFAULT_VERIFICATION_POLICY.gateRoles);
	});

	it("gateRoles: an explicit empty object is honored (a project may intentionally clear roles)", () => {
		assert.deepEqual(resolveVerificationPolicy({ gateRoles: {} }).gateRoles, {});
	});

	it("gateRoles: malformed sub-fields are dropped per-key, not the whole role", () => {
		const resolved = resolveVerificationPolicy({
			gateRoles: {
				"ready-to-merge": { childRewrite: "not-a-real-value", requiredBuiltins: ["branch", 42, "cwd"] },
				"custom-gate": { childRewrite: "none" },
			},
		});
		// childRewrite invalid + requiredBuiltins has a non-string entry => whole array dropped, but role still present if any valid field
		assert.equal(resolved.gateRoles["ready-to-merge"], undefined);
		assert.deepEqual(resolved.gateRoles["custom-gate"], { childRewrite: "none" });
	});

	it("reviewVerdictRubric: only a non-empty string overrides; blank/missing falls back", () => {
		assert.equal(resolveVerificationPolicy({ reviewVerdictRubric: "custom rubric" }).reviewVerdictRubric, "custom rubric");
		assert.equal(resolveVerificationPolicy({ reviewVerdictRubric: "" }).reviewVerdictRubric, DEFAULT_VERIFICATION_POLICY.reviewVerdictRubric);
		assert.equal(resolveVerificationPolicy({ reviewVerdictRubric: "   " }).reviewVerdictRubric, DEFAULT_VERIFICATION_POLICY.reviewVerdictRubric);
		assert.equal(resolveVerificationPolicy({ reviewVerdictRubric: 7 }).reviewVerdictRubric, DEFAULT_VERIFICATION_POLICY.reviewVerdictRubric);
	});

	it("a fully-specified valid object round-trips exactly", () => {
		const custom: VerificationPolicy = {
			gateCacheDefault: "content",
			parallelReviewsDefault: false,
			gateRoles: { "my-gate": { childRewrite: "none", requiredBuiltins: ["x"] } },
			reviewVerdictRubric: "custom",
		};
		assert.deepEqual(resolveVerificationPolicy(custom), custom);
	});
});

describe("mergeVerificationPolicyRaw", () => {
	it("override wins per top-level field; base fields not present in override survive", () => {
		const merged = mergeVerificationPolicyRaw(
			{ gateCacheDefault: "sha", parallelReviewsDefault: true },
			{ gateCacheDefault: "content" },
		);
		assert.equal(merged.gateCacheDefault, "content");
		assert.equal(merged.parallelReviewsDefault, true);
	});

	it("gateRoles is merged by key, not replaced wholesale", () => {
		const merged = mergeVerificationPolicyRaw(
			{ gateRoles: { "ready-to-merge": { childRewrite: "adapt-ready-to-merge" } } },
			{ gateRoles: { "custom-gate": { childRewrite: "none" } } },
		);
		assert.deepEqual(merged.gateRoles, {
			"ready-to-merge": { childRewrite: "adapt-ready-to-merge" },
			"custom-gate": { childRewrite: "none" },
		});
	});

	it("override's gateRoles entry for the same key wins over base's", () => {
		const merged = mergeVerificationPolicyRaw(
			{ gateRoles: { "ready-to-merge": { childRewrite: "adapt-ready-to-merge" } } },
			{ gateRoles: { "ready-to-merge": { childRewrite: "none" } } },
		);
		assert.deepEqual(merged.gateRoles, { "ready-to-merge": { childRewrite: "none" } });
	});

	it("non-object/array base or override is treated as empty", () => {
		assert.deepEqual(mergeVerificationPolicyRaw(undefined, { gateCacheDefault: "content" }), { gateCacheDefault: "content" });
		assert.deepEqual(mergeVerificationPolicyRaw({ gateCacheDefault: "sha" }, null), { gateCacheDefault: "sha" });
		assert.deepEqual(mergeVerificationPolicyRaw([1, 2], { gateCacheDefault: "sha" }), { gateCacheDefault: "sha" });
	});

	it("chained merge (builtin -> server -> project) composes left-to-right", () => {
		const builtin = { gateCacheDefault: "sha", parallelReviewsDefault: true };
		const server = { parallelReviewsDefault: false };
		const project = { gateCacheDefault: "content" };
		const merged = mergeVerificationPolicyRaw(mergeVerificationPolicyRaw(builtin, server), project);
		assert.deepEqual(merged, { gateCacheDefault: "content", parallelReviewsDefault: false });
	});
});

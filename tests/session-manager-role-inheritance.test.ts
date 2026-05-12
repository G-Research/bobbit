/**
 * Contract test: SessionManager's role-field resolvers must delegate to the
 * field-level cascade (ConfigCascade.resolveRoleModel /
 * resolveRoleThinkingLevel / resolveRolePromptTemplate) rather than the
 * full-item `resolveRoles()` call. This locks in the hierarchical
 * inheritance wiring (project → ancestor chain → server → builtin).
 *
 * We can't import SessionManager directly here (it transitively pulls in
 * flexsearch, which Node 25 ESM rejects via tsx — same constraint as
 * tests/get-image-model-for-session.test.ts). Instead we assert the
 * production source contains exactly the expected wiring at each call
 * site. The actual cascade walk is covered by
 * tests/config-cascade-role-fields.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
	path.resolve(__dirname, "..", "src/server/agent/session-manager.ts"),
	"utf-8",
);

function bodyOf(signaturePattern: RegExp): string {
	const m = signaturePattern.exec(SRC);
	assert.ok(m, `signature not found: ${signaturePattern}`);
	// Find balanced braces from the first `{` after the match.
	let i = SRC.indexOf("{", m.index + m[0].length - 1);
	assert.ok(i > -1, "no opening brace");
	let depth = 0;
	for (let j = i; j < SRC.length; j++) {
		const ch = SRC[j];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return SRC.slice(i, j + 1);
		}
	}
	throw new Error("unbalanced braces");
}

describe("SessionManager — role-field cascade wiring", () => {
	it("resolveRoleModel(session) delegates to configCascade.resolveRoleModel", () => {
		const body = bodyOf(/private\s+resolveRoleModel\(session:\s*SessionInfo\)/);
		assert.match(body, /this\.configCascade\.resolveRoleModel\(\s*session\.role\s*,\s*session\.projectId\s*\)/);
		assert.doesNotMatch(body, /resolveRoles\(/);
	});

	it("resolveRoleThinkingLevel(session) delegates to configCascade.resolveRoleThinkingLevel", () => {
		const body = bodyOf(/private\s+resolveRoleThinkingLevel\(session:\s*SessionInfo\)/);
		assert.match(body, /this\.configCascade\.resolveRoleThinkingLevel\(\s*session\.role\s*,\s*session\.projectId\s*\)/);
		assert.doesNotMatch(body, /resolveRoles\(/);
	});

	it("resolveInitialModel uses configCascade.resolveRoleModel and preserves preference fallback", () => {
		const body = bodyOf(/\bresolveInitialModel\(role:\s*string\s*\|\s*undefined,\s*projectId:\s*string\s*\|\s*undefined\)/);
		assert.match(body, /this\.configCascade\.resolveRoleModel\(\s*role\s*,\s*projectId\s*\)/);
		assert.match(body, /default\.sessionModel/);
		assert.doesNotMatch(body, /resolveRoles\(/);
	});

	it("resolveInitialThinkingLevel uses configCascade.resolveRoleThinkingLevel and preserves preference/'medium' fallback", () => {
		const body = bodyOf(/\bresolveInitialThinkingLevel\(role:\s*string\s*\|\s*undefined,\s*projectId:\s*string\s*\|\s*undefined\)/);
		assert.match(body, /this\.configCascade\.resolveRoleThinkingLevel\(\s*role\s*,\s*projectId\s*\)/);
		assert.match(body, /default\.sessionThinkingLevel/);
		assert.match(body, /"medium"/);
		assert.doesNotMatch(body, /resolveRoles\(/);
	});

	it("resolveInitialReviewModel uses configCascade.resolveRoleModel and falls back to default.reviewModel", () => {
		const body = bodyOf(/\bresolveInitialReviewModel\(role:\s*string\s*\|\s*undefined,\s*projectId:\s*string\s*\|\s*undefined\)/);
		assert.match(body, /this\.configCascade\.resolveRoleModel\(\s*role\s*,\s*projectId\s*\)/);
		assert.match(body, /default\.reviewModel/);
		assert.doesNotMatch(body, /resolveRoles\(/);
	});

	it("system-prompt assembly paths use the field-level promptTemplate resolver", () => {
		// SessionManager defines a `resolveRolePromptTemplate` helper that the
		// four prompt-assembly paths (getPromptParts assistant + team, and
		// the restore-session assistant + team) call into.
		assert.match(SRC, /private\s+resolveRolePromptTemplate\(roleName:\s*string,\s*projectId:\s*string\s*\|\s*undefined\)/);
		const helperBody = bodyOf(/private\s+resolveRolePromptTemplate\(roleName:\s*string,\s*projectId:\s*string\s*\|\s*undefined\)/);
		assert.match(helperBody, /this\.configCascade\.resolveRolePromptTemplate\(roleName,\s*projectId\)/);
		// Helper must call into the field-level cascade first, then fall
		// back to roleManager.getRole for system-scope sessions.
		assert.match(helperBody, /this\.roleManager\?\.getRole\(roleName\)\?\.promptTemplate/);
		// Each of the four call sites uses the helper.
		const usages = SRC.match(/this\.resolveRolePromptTemplate\(/g) || [];
		assert.ok(usages.length >= 4, `expected >=4 resolveRolePromptTemplate call sites, got ${usages.length}`);
	});
});

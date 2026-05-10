/**
 * Pin: route handlers should live in src/server/routes/ — handleApiRoute()
 * should not grow new direct `req.method ===` branches.
 *
 * Initial budget pins the current count so future drift is caught. Lower
 * the budget in the same commit as a migration that reduces it.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = path.join(repoRoot, "src", "server", "server.ts");

// Current count of `req.method ===` lines inside server.ts (handleApiRoute body).
// Ratchet downward in commits that migrate more routes.
const MAX_REQ_METHOD_REFS = 5;

describe("server.ts route-handler leakage", () => {
	it(`server.ts contains ≤ ${MAX_REQ_METHOD_REFS} \`req.method ===\` references`, () => {
		const text = fs.readFileSync(serverFile, "utf-8");
		const matches = text.match(/req\.method\s*===/g) || [];
		assert.ok(
			matches.length <= MAX_REQ_METHOD_REFS,
			`server.ts has ${matches.length} \`req.method ===\` references (limit ${MAX_REQ_METHOD_REFS}). ` +
			`New REST handlers MUST live in src/server/routes/<domain>.ts.`,
		);
	});
});

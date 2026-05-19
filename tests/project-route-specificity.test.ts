import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "src", "server", "server.ts");

function findRegexClosingSlash(literal: string): number {
	let escaped = false;
	let inCharacterClass = false;

	for (let i = 1; i < literal.length; i += 1) {
		const ch = literal[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "[") {
			inCharacterClass = true;
			continue;
		}
		if (ch === "]") {
			inCharacterClass = false;
			continue;
		}
		if (ch === "/" && !inCharacterClass) return i;
	}

	return -1;
}

function regexFromLiteral(literal: string): RegExp {
	const trimmed = literal.trim();
	assert.ok(trimmed.startsWith("/"), "project route matcher must be a regex literal in this regression test");
	const closingSlash = findRegexClosingSlash(trimmed);
	assert.notEqual(closingSlash, -1, "project route matcher regex literal must be closed");

	const pattern = trimmed.slice(1, closingSlash);
	const flags = trimmed.slice(closingSlash + 1);
	return new RegExp(pattern, flags);
}

function extractProjectIdRouteMatcher(source: string): RegExp {
	const match = source.match(/const\s+projectGetMatch\s*=\s*url\.pathname\.match\(([^\n;]+)\);/);
	assert.ok(match, "expected src/server/server.ts to define the generic project id route matcher");
	return regexFromLiteral(match[1]);
}

test("generic project id route excludes reserved project order endpoint", () => {
	const source = fs.readFileSync(SERVER_PATH, "utf-8");
	const projectIdRoute = extractProjectIdRouteMatcher(source);

	assert.equal(projectIdRoute.test("/api/projects/regular-project"), true);
	assert.equal(
		projectIdRoute.test("/api/projects/order"),
		false,
		"reserved project order route must not match generic project id route",
	);
});

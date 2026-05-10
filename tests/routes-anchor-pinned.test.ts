/**
 * Pin: every Route.pattern that is a RegExp must be anchored ^...$.
 *
 * Linear-scan dispatch with anchored regexes guarantees at most one match
 * per (method, pathname). Drift (someone copy-pastes an unanchored regex)
 * silently breaks ordering and lets a generic prefix swallow specific
 * routes — see docs/design/server-routes-split.md §9.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routesDir = path.join(repoRoot, "src", "server", "routes");

function listRouteFiles(): string[] {
	return fs.readdirSync(routesDir)
		.filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"))
		.map(f => path.join(routesDir, f));
}

/**
 * Walk a TS source string and yield every regex-literal body for occurrences
 * of `pattern: /.../`. Handles character classes (`[^/]`), escaped slashes,
 * and trailing flags. Doing this with a regex over TS source is unreliable
 * (the original implementation tripped on `[^/]`), so we hand-scan.
 */
function* extractPatternRegexBodies(text: string): Generator<string> {
	const marker = "pattern";
	let i = 0;
	while (i < text.length) {
		const found = text.indexOf(marker, i);
		if (found < 0) return;
		i = found + marker.length;
		// Skip whitespace + colon
		while (i < text.length && /\s/.test(text[i])) i++;
		if (text[i] !== ":") continue;
		i++;
		while (i < text.length && /\s/.test(text[i])) i++;
		if (text[i] !== "/") continue; // not a regex literal — likely a string
		// We're at the opening `/` of a regex literal. Walk until matching `/`,
		// honouring `\`-escapes and `[...]` character classes (where `/` is literal).
		const start = i + 1;
		let j = start;
		let inClass = false;
		while (j < text.length) {
			const c = text[j];
			if (c === "\\") { j += 2; continue; }
			if (c === "[" && !inClass) { inClass = true; j++; continue; }
			if (c === "]" && inClass) { inClass = false; j++; continue; }
			if (c === "/" && !inClass) break;
			if (c === "\n") break; // not a regex literal
			j++;
		}
		if (j < text.length && text[j] === "/") {
			yield text.slice(start, j);
			i = j + 1;
		}
	}
}

describe("routes: anchored RegExp patterns", () => {
	it("every `pattern: /.../` literal in src/server/routes/*.ts is anchored ^...$", () => {
		const offenders: string[] = [];
		for (const file of listRouteFiles()) {
			const text = fs.readFileSync(file, "utf-8");
			for (const body of extractPatternRegexBodies(text)) {
				if (!body.startsWith("^") || !body.endsWith("$")) {
					offenders.push(`${path.relative(repoRoot, file)}: /${body}/`);
				}
			}
		}
		assert.deepEqual(offenders, [], `Unanchored regex pattern(s):\n${offenders.join("\n")}`);
	});
});

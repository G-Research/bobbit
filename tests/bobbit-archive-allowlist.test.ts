/**
 * Pinning test: every distinct `state/` child segment written by
 * `bobbitStateDir(...)`-anchored code under src/server/ must appear in
 * `GATEWAY_OWNED_FILES` OR be annotated `// archive-safe` near the call site.
 *
 * If this test fails, a new server-level state writer has been added without
 * updating the allowlist. Either:
 *   - Add the segment to GATEWAY_OWNED_FILES in src/server/agent/bobbit-archive.ts, or
 *   - Add `// archive-safe` on the line of the write site if it is genuinely
 *     project-scoped and SHOULD be archived.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GATEWAY_OWNED_FILES } from "../src/server/agent/bobbit-archive.js";

const SERVER_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"server",
);

/** Recursively walk SERVER_DIR for .ts files. */
function walkTs(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walkTs(full, out);
		else if (e.isFile() && full.endsWith(".ts")) out.push(full);
	}
	return out;
}

/**
 * Find every line that joins `bobbitStateDir(...)` with a literal child
 * segment. Returns array of { file, line, segment, raw }.
 *
 * Supported patterns:
 *   path.join(bobbitStateDir(), "foo", ...)
 *   path.join(stateDir, "foo", ...)        — when nearby `const stateDir = bobbitStateDir(...)`
 *   `${bobbitStateDir()}/foo`
 *   "model-name-" + sessionId
 */
interface WriteSite { file: string; line: number; segment: string; raw: string; }

function findWriteSites(): WriteSite[] {
	const files = walkTs(SERVER_DIR);
	const sites: WriteSite[] = [];

	// Patterns for direct uses
	// path.join(bobbitStateDir(...), "child", ...)
	const reJoin = /path\.join\(\s*bobbitStateDir\([^)]*\)\s*,\s*["']([^"']+)["']/g;
	// `${bobbitStateDir()}/child` or "..." + bobbitStateDir() + ...
	const reTemplate = /bobbitStateDir\([^)]*\)\s*,\s*["']([^"']+)["']/g;
	const reBackticks = /\$\{bobbitStateDir\([^}]*\)\}\/([A-Za-z0-9._-]+)/g;
	// Capture `const NAME = bobbitStateDir(...)` so we can resolve indirect uses.
	const reAlias = /const\s+(\w+)\s*=\s*bobbitStateDir\(/g;
	// "model-name-" + sessionId — special case
	const reModelName = /["'](model-name-)["']\s*\+/g;

	for (const f of files) {
		// Skip the allowlist module itself (it lists segments as strings,
		// but they are documentation and reference, not new write sites).
		if (f.endsWith(path.join("agent", "bobbit-archive.ts"))) continue;
		// Skip the project-preflight module — it reads gateway-url and
		// watchdog.json by name to detect gateway-owned, but doesn't write.
		if (f.endsWith(path.join("agent", "project-preflight.ts"))) continue;
		const text = fs.readFileSync(f, "utf-8");
		const lines = text.split(/\r?\n/);
		const aliases = new Set<string>();
		for (const m of text.matchAll(reAlias)) aliases.add(m[1]);

		// Per-line scan
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.includes("// archive-safe")) continue;
			let m: RegExpExecArray | null;

			// path.join(bobbitStateDir(), "X")
			reJoin.lastIndex = 0;
			while ((m = reJoin.exec(line)) !== null) {
				sites.push({ file: f, line: i + 1, segment: m[1], raw: line.trim() });
			}
			// bobbitStateDir(), "X" anywhere — covers wrapping calls
			reTemplate.lastIndex = 0;
			while ((m = reTemplate.exec(line)) !== null) {
				if (!line.includes("path.join")) {
					sites.push({ file: f, line: i + 1, segment: m[1], raw: line.trim() });
				}
			}
			reBackticks.lastIndex = 0;
			while ((m = reBackticks.exec(line)) !== null) {
				sites.push({ file: f, line: i + 1, segment: m[1], raw: line.trim() });
			}
			// alias uses, e.g. path.join(stateDir, "X")
			for (const alias of aliases) {
				const re = new RegExp(`path\\.join\\(\\s*${alias}\\s*,\\s*["']([^"']+)["']`, "g");
				let am: RegExpExecArray | null;
				while ((am = re.exec(line)) !== null) {
					sites.push({ file: f, line: i + 1, segment: am[1], raw: line.trim() });
				}
			}
			// model-name-* concat
			reModelName.lastIndex = 0;
			if (reModelName.exec(line) && (line.includes("bobbitStateDir") || aliases.size > 0)) {
				sites.push({ file: f, line: i + 1, segment: "model-name-", raw: line.trim() });
			}
		}
	}
	return sites;
}

function isCoveredByAllowlist(segment: string): boolean {
	// Allowlist entries are of the form "state/<segment>" or
	// "state/<dir>/" or "state/<prefix>*". Compare against just the
	// state-level child segment we extracted from the source.
	for (const entry of GATEWAY_OWNED_FILES) {
		if (!entry.startsWith("state/")) continue;
		const child = entry.slice("state/".length);
		// Directory subtree
		if (child.endsWith("/")) {
			const dir = child.slice(0, -1);
			if (segment === dir) return true;
			continue;
		}
		// Wildcard prefix
		if (child.includes("*")) {
			const star = child.indexOf("*");
			const prefix = child.slice(0, star);
			const suffix = child.slice(star + 1);
			if (segment.startsWith(prefix) && segment.endsWith(suffix)) return true;
			continue;
		}
		// Exact match
		if (segment === child) return true;
	}
	return false;
}

test("every bobbitStateDir() write site segment is in GATEWAY_OWNED_FILES or annotated `// archive-safe`", () => {
	const sites = findWriteSites();
	assert.ok(sites.length > 0, "regex should have found SOME write sites; check pattern drift");
	const missing: WriteSite[] = [];
	for (const s of sites) {
		if (!isCoveredByAllowlist(s.segment)) missing.push(s);
	}
	if (missing.length > 0) {
		const lines = missing.map(m =>
			`  ${path.relative(path.join(SERVER_DIR, ".."), m.file)}:${m.line}  segment="${m.segment}"\n    ${m.raw}`,
		);
		assert.fail(
			`Found ${missing.length} bobbitStateDir() write site(s) with segments not in GATEWAY_OWNED_FILES.\n` +
			`Either add the segment to src/server/agent/bobbit-archive.ts::GATEWAY_OWNED_FILES,\n` +
			`or annotate the line with \`// archive-safe\` if it is genuinely project-scoped.\n\n` +
			lines.join("\n"),
		);
	}
});

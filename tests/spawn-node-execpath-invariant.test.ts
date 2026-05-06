/**
 * Lesson 4.5 invariant — every node-process spawn site under `src/server/`
 * must use `process.execPath`, never the bare string `"node"`.
 *
 * Bare `spawn("node", ...)` fails under sanitised PATH (e.g. when the
 * dev harness scrubs PATH for child processes) because the child has no
 * way to find the node binary. `process.execPath` is the absolute path
 * to the running node binary, which is always correct.
 *
 * If this test fails, replace `spawn("node", [...])` with
 * `spawn(process.execPath, [...])` at the offending site. See the
 * "Lesson 4.5" entry in `docs/design/subgoals-retro-audit.md` §4.2.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const SERVER_DIR = path.resolve(import.meta.dirname, "..", "src", "server");

/** Recursively collect *.ts files (excluding *.d.ts). */
function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(full, out);
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("spawn-node-execpath invariant", () => {
	it("no `spawn(\"node\"` callsites under src/server/", () => {
		const files = collectTsFiles(SERVER_DIR);
		const offenders: { file: string; line: number; text: string }[] = [];
		// Match `spawn("node"` or `spawn('node'` as a function call.
		// Allow whitespace between `spawn` and `(`. Comments are allowed
		// (only callsites are flagged).
		const pattern = /\bspawn\s*\(\s*["']node["']/;
		for (const file of files) {
			const text = fs.readFileSync(file, "utf8");
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// Skip comment-only lines (// or * inside block comment) — comments
				// referencing the historical `spawn("node", { cwd })` shape are fine.
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
				if (pattern.test(line)) {
					offenders.push({ file: path.relative(SERVER_DIR, file), line: i + 1, text: line.trim() });
				}
			}
		}
		assert.deepEqual(
			offenders,
			[],
			`Found ${offenders.length} bare \`spawn("node", ...)\` callsite(s) under src/server/. ` +
				`Replace each with \`spawn(process.execPath, ...)\`. Offenders:\n` +
				offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
		);
	});
});

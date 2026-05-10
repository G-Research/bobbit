/**
 * Static AST scan that pins the listener-cleanup convention from
 * `docs/design/listener-cleanup-standardisation.md`:
 *
 *   Every `addEventListener` call in `src/ui/components/**` MUST pass an
 *   `{ signal }` option as the third argument.
 *
 * Files that have not yet been migrated are exempt via
 * `tests/fixtures/listener-cleanup-allowlist.txt`. Each migration commit
 * removes one line from that file. Once empty, the allowlist file is
 * deleted and the rule applies to every file unconditionally.
 *
 * This test uses the raw `typescript` compiler API — it adds no new
 * dependency. See design doc §3.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "src", "ui", "components");
const BASE_DIR = path.join(SCAN_ROOT, "base");
const ALLOWLIST_PATH = path.join(REPO_ROOT, "tests", "fixtures", "listener-cleanup-allowlist.txt");

/** Walk a directory recursively, returning absolute paths to .ts files. */
function walkTsFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const abs = path.join(dir, name);
			let st;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				stack.push(abs);
				continue;
			}
			if (!st.isFile()) continue;
			if (!name.endsWith(".ts")) continue;
			if (name.endsWith(".test.ts") || name.endsWith(".spec.ts") || name.endsWith(".d.ts")) continue;
			// Exclude the base/ directory — it defines the helpers and is
			// allowed to bind via signal-bearing APIs without itself calling
			// addEventListener through them.
			if (abs.startsWith(BASE_DIR + path.sep) || abs === BASE_DIR) continue;
			out.push(abs);
		}
	}
	return out;
}

interface Offense {
	relPath: string;
	line: number;
	column: number;
	reason: "missing-options" | "options-no-signal";
}

/** Scan one TS source file for non-compliant addEventListener calls. */
function scanFile(absPath: string, relPath: string): Offense[] {
	const source = readFileSync(absPath, "utf8");
	const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.ES2022, /*setParentNodes*/ true, ts.ScriptKind.TS);
	const offenses: Offense[] = [];

	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			let methodName: string | undefined;
			if (ts.isPropertyAccessExpression(callee)) {
				methodName = callee.name.text;
			} else if (ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteralLike(callee.argumentExpression)) {
				methodName = callee.argumentExpression.text;
			}
			if (methodName === "addEventListener") {
				const args = node.arguments;
				const offense = checkOptions(args);
				if (offense) {
					const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
					offenses.push({
						relPath,
						line: line + 1,
						column: character + 1,
						reason: offense,
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);
	return offenses;
}

/** Returns the offense reason if the args are non-compliant, else null. */
function checkOptions(args: readonly ts.Expression[]): Offense["reason"] | null {
	if (args.length < 3) return "missing-options";
	const opts = args[2]!;
	if (ts.isObjectLiteralExpression(opts)) {
		for (const prop of opts.properties) {
			// { signal: ... }
			if (ts.isPropertyAssignment(prop) && propertyKeyText(prop.name) === "signal") return null;
			// { signal } shorthand
			if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "signal") return null;
			// { ...spread } — assume compliant; spread analysis is out of scope
			if (ts.isSpreadAssignment(prop)) return null;
		}
		return "options-no-signal";
	}
	// Non-literal 3rd arg (e.g. a boolean capture flag, or an identifier we
	// cannot statically inspect). The convention requires a literal
	// `{ signal }` options object, so flag this site.
	return "options-no-signal";
}

function propertyKeyText(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name)) return name.text;
	if (ts.isStringLiteralLike(name)) return name.text;
	return undefined;
}

interface Allowlist {
	entries: string[];
	set: Set<string>;
}

function readAllowlist(): Allowlist {
	if (!existsSync(ALLOWLIST_PATH)) {
		return { entries: [], set: new Set() };
	}
	const raw = readFileSync(ALLOWLIST_PATH, "utf8");
	const entries: string[] = [];
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("#")) continue;
		entries.push(line);
	}
	return { entries, set: new Set(entries) };
}

function relFromRepo(abs: string): string {
	return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

describe("listener-cleanup AST scan", () => {
	it("every addEventListener in src/ui/components/** passes { signal }, except files on the allowlist", () => {
		const files = walkTsFiles(SCAN_ROOT);
		const allowlist = readAllowlist();
		const nonCompliantFiles = new Map<string, Offense[]>();
		const compliantFiles = new Set<string>();
		const filesWithListeners = new Set<string>();

		for (const abs of files) {
			const rel = relFromRepo(abs);
			const offenses = scanFile(abs, rel);
			const hasAnyListener = fileHasAddEventListener(abs);
			if (hasAnyListener) filesWithListeners.add(rel);
			if (offenses.length > 0) {
				nonCompliantFiles.set(rel, offenses);
			} else if (hasAnyListener) {
				compliantFiles.add(rel);
			}
		}

		// 1) Every non-compliant file must be on the allowlist.
		const unexpected: string[] = [];
		for (const [rel, offs] of nonCompliantFiles) {
			if (!allowlist.set.has(rel)) {
				const sites = offs.map((o) => `      ${rel}:${o.line}:${o.column}  (${o.reason})`).join("\n");
				unexpected.push(`  - ${rel}\n${sites}`);
			}
		}

		// 2) Allowlist entries must (a) exist on disk, (b) actually have
		//    addEventListener calls, and (c) actually be non-compliant —
		//    otherwise the entry has been silently neutralised and should
		//    be removed (the allowlist is a true ratchet).
		const stale: string[] = [];
		for (const entry of allowlist.entries) {
			const abs = path.join(REPO_ROOT, entry.split("/").join(path.sep));
			if (!existsSync(abs)) {
				stale.push(`  - ${entry}  (file does not exist)`);
				continue;
			}
			if (!filesWithListeners.has(entry)) {
				stale.push(`  - ${entry}  (no addEventListener calls — remove from allowlist)`);
				continue;
			}
			if (!nonCompliantFiles.has(entry)) {
				stale.push(`  - ${entry}  (now compliant — remove from allowlist)`);
			}
		}

		const messages: string[] = [];
		if (unexpected.length > 0) {
			messages.push(
				"The following files use addEventListener without { signal } and are NOT on the allowlist.\n" +
					"Either add { signal: this.signal } as the 3rd argument, or — if this is\n" +
					"intentional during migration — add the file to\n" +
					"  tests/fixtures/listener-cleanup-allowlist.txt\n" +
					unexpected.join("\n"),
			);
		}
		if (stale.length > 0) {
			messages.push(
				"The following allowlist entries are stale and must be removed from\n" +
					"  tests/fixtures/listener-cleanup-allowlist.txt:\n" +
					stale.join("\n"),
			);
		}

		assert.equal(messages.length, 0, messages.join("\n\n"));
	});
});

/** Quick check: does the file source contain the literal `addEventListener`? */
function fileHasAddEventListener(absPath: string): boolean {
	const src = readFileSync(absPath, "utf8");
	if (!src.includes("addEventListener")) return false;
	// Confirm via AST so comments/strings don't false-positive.
	const sf = ts.createSourceFile(absPath, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
	let found = false;
	function visit(node: ts.Node): void {
		if (found) return;
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			let methodName: string | undefined;
			if (ts.isPropertyAccessExpression(callee)) methodName = callee.name.text;
			else if (ts.isElementAccessExpression(callee) && callee.argumentExpression && ts.isStringLiteralLike(callee.argumentExpression))
				methodName = callee.argumentExpression.text;
			if (methodName === "addEventListener") {
				found = true;
				return;
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return found;
}

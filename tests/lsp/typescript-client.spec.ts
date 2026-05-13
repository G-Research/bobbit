/**
 * typescript-language-server adapter integration test.
 *
 * Spawns a real LSP child against tests/fixtures/lsp-ts/.
 * Skipped automatically if typescript-language-server isn't resolvable.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TypescriptLspFactory } from "../../src/server/lsp/clients/typescript.ts";
import type { LspClient } from "../../src/server/lsp/client.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "lsp-ts");

const factory = new TypescriptLspFactory();
const HAS_LSP = factory.isInstalled();

const skip = !HAS_LSP ? { skip: "typescript-language-server not installed" } : undefined;

describe("typescript LSP adapter", skip, () => {
	let client: LspClient;
	const mathPath = path.join(FIXTURE, "src", "math.ts");
	const indexPath = path.join(FIXTURE, "src", "index.ts");
	let originalMath: string;

	before(async () => {
		client = await factory.spawn({ worktreePath: FIXTURE });
		originalMath = await fs.readFile(mathPath, "utf-8");
		// Pre-open both docs.
		await client.ensureDocOpen(mathPath);
		await client.ensureDocOpen(indexPath);
	});

	after(async () => {
		try { await fs.writeFile(mathPath, originalMath, "utf-8"); } catch { /* ignore */ }
		await client.shutdown(true);
	});

	test("definition of add() in index.ts resolves to math.ts", async () => {
		// "const x = add(1, 2);" — `add` starts at character 10 on line 2.
		const loc = await client.definition(indexPath, 2, 10);
		assert.ok(loc, "expected a definition");
		assert.ok(loc!.path.endsWith(path.join("src", "math.ts")), `got ${loc!.path}`);
		assert.equal(loc!.range.start.line, 0);
	});

	test("references with and without declaration", async () => {
		// `add` declaration on math.ts line 0 character 16.
		const withDecl = await client.references(mathPath, 0, 16, true);
		const withoutDecl = await client.references(mathPath, 0, 16, false);
		assert.ok(withDecl.length >= 2, `expected ≥2 hits with decl, got ${withDecl.length}`);
		assert.ok(withoutDecl.length >= 1, `expected ≥1 hit without decl, got ${withoutDecl.length}`);
		assert.ok(withDecl.length > withoutDecl.length, "includeDecl=true should yield more hits");
	});

	test("hover on add() returns a non-empty string", async () => {
		const h = await client.hover(mathPath, 0, 16);
		assert.ok(h, "expected a hover result");
		assert.ok(h!.contents.length > 0);
		assert.ok(/add/.test(h!.contents));
	});

	test("documentSymbols returns at least one symbol named add", async () => {
		const syms = await client.documentSymbols(mathPath);
		assert.ok(syms.length >= 1, "expected at least one symbol");
		const all = JSON.stringify(syms);
		assert.ok(/"add"/.test(all), "expected symbol named 'add'");
	});

	test("rename produces a WorkspaceEdit covering math.ts and index.ts", async () => {
		const we = await client.rename(mathPath, 0, 16, "sum");
		const keys = Object.keys(we.changes);
		assert.ok(keys.length >= 2, `expected ≥2 files in edit, got ${keys.length}`);
		const hasMath = keys.some(k => k.endsWith("math.ts"));
		const hasIndex = keys.some(k => k.endsWith("index.ts"));
		assert.ok(hasMath && hasIndex, `missing one of math/index in ${keys.join(",")}`);
	});

	test("diagnostics: clean → type error → revert", async () => {
		// Baseline: should be clean.
		const clean = await client.diagnostics(mathPath);
		assert.equal(clean.length, 0, `baseline diagnostics not clean: ${JSON.stringify(clean)}`);

		// Introduce a type error.
		await fs.writeFile(mathPath, `export function add(a: number, b: number): number {\n\treturn a + b + "oops";\n}\n`, "utf-8");
		await client.ensureDocOpen(mathPath);  // triggers didChange
		await new Promise(r => setTimeout(r, 300));
		const dirty = await client.diagnostics(mathPath);
		assert.ok(dirty.length >= 1, "expected diagnostics after introducing type error");

		// Revert.
		await fs.writeFile(mathPath, originalMath, "utf-8");
		await client.ensureDocOpen(mathPath);
		await new Promise(r => setTimeout(r, 300));
		const reverted = await client.diagnostics(mathPath);
		assert.equal(reverted.length, 0, `expected clean after revert, got ${JSON.stringify(reverted)}`);
	});
});

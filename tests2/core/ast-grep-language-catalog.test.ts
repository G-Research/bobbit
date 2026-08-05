import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CODE_INTELLIGENCE_LANGUAGE_MATRIX,
	detectAstGrepLanguages,
	languagesForExtension,
	normalizeAstGrepLanguage,
} from "../../market-packs/code-intelligence/lib/language-matrix.ts";

describe("ast-grep language catalogue", () => {
	it("uses the canonical data-driven AST shape without LSP capability data", () => {
		expect(CODE_INTELLIGENCE_LANGUAGE_MATRIX.every((language) => language.ast.supported)).toBe(true);
		expect(normalizeAstGrepLanguage("PYTHON")).toMatchObject({
			id: "python",
			label: "Python",
			evidence: { globs: expect.arrayContaining(["**/*.py", "**/*.pyi"]) },
			ast: { supported: true, grammar: "Python" },
		});
		expect(normalizeAstGrepLanguage("not-a-language")).toBeUndefined();
		expect(CODE_INTELLIGENCE_LANGUAGE_MATRIX.every((language) => !("alias" in language || "cliLanguage" in language || "extensions" in language || "structuralSearch" in language))).toBe(true);
	});

	it("maps required extensions and makes collisions explicit", () => {
		expect(languagesForExtension(".cts")).toEqual(["typescript"]);
		expect(languagesForExtension(".mts")).toEqual(["typescript"]);
		expect(languagesForExtension(".pyi")).toEqual(["python"]);
		expect(languagesForExtension(".YML")).toEqual(["yaml"]);
		expect(languagesForExtension(".h")).toEqual(["c", "cpp"]);
	});

	it("detects supported files without following symlinks or build directories", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ast-grep-language-"));
		try {
			fs.writeFileSync(path.join(root, "app.ts"), "export const x = 1;");
			fs.writeFileSync(path.join(root, "tool.py"), "x = 1");
			fs.mkdirSync(path.join(root, "dist"));
			fs.writeFileSync(path.join(root, "dist", "ignored.rs"), "fn main() {}");
			fs.symlinkSync(path.join(root, "tool.py"), path.join(root, "linked.py"));
			expect(detectAstGrepLanguages([root])).toEqual(["python", "typescript"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

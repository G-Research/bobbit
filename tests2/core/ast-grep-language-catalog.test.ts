import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AST_GREP_LANGUAGES,
	detectAstGrepLanguages,
	languagesForExtension,
	normalizeAstGrepLanguage,
} from "../../defaults/tools/code-intel/ast-grep-languages.ts";

describe("ast-grep language catalogue", () => {
	it("is data-driven, normalizes aliases, and retains AST-only grammars", () => {
		expect(AST_GREP_LANGUAGES.every((language) => language.structuralSearch)).toBe(true);
		expect(normalizeAstGrepLanguage("PYTHON")?.cliLanguage).toBe("Python");
		expect(normalizeAstGrepLanguage("not-a-language")).toBeUndefined();
		expect(normalizeAstGrepLanguage("python")?.structuralSearch).toBe(true);
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

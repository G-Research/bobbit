import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeAstGrep, type AstGrepExecResult } from "../../market-packs/code-intelligence/tools/ast/ast-grep-runner.ts";

function fixture(): { root: string; dispose: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ast-grep-runner-"));
	fs.writeFileSync(path.join(root, "sample.ts"), "console.log(value);\n");
	return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const noMatches: AstGrepExecResult = { exitCode: 0, stdout: "", stderr: "" };

describe("ast-grep runner", () => {
	it("uses a no-shell argv with defaults and normalizes zero-based ranges", async () => {
		const f = fixture();
		try {
			let call: { file: string; args: readonly string[]; cwd: string } | undefined;
			const result = await executeAstGrep({ pattern: "console.log($$$ARGS)" }, {
				cwd: f.root,
				detectLanguages: () => ["typescript"],
				exec: async (file, args, options) => {
					call = { file, args, cwd: options.cwd };
					return { exitCode: 0, stderr: "", stdout: JSON.stringify({
						file: "sample.ts", text: "console.log(value)",
						range: { start: { line: 0, column: 0 }, end: { line: 0, column: 18 } },
						metaVariables: { multi: { ARGS: "value" } },
					}) + "\n" };
				},
			});
			expect(call!.file).toBe("sg");
			expect(call!.cwd).toBe(fs.realpathSync(f.root));
			expect(call!.args).toEqual([
				"run", "--pattern", "console.log($$$ARGS)", "--lang", "TypeScript", "--strictness", "smart",
				"--json=stream", "--color", "never", "--heading", "never", ".",
			]);
			expect(call!.args.join(" ")).not.toMatch(/rewrite|interactive|update-all/);
			expect(result.matches).toMatchObject([{ file: "sample.ts", line: 1, range: { start: { line: 0, column: 0 } } }]);
			expect(result.matches[0].metaVariables).toEqual({ multi: { ARGS: "value" } });
		} finally { f.dispose(); }
	});

	it("validates paths, language, strictness, and supports a successful no-match", async () => {
		const f = fixture();
		try {
			await expect(executeAstGrep({ pattern: "x", paths: ["../escape"] }, { cwd: f.root })).rejects.toThrow(/cannot traverse/);
			await expect(executeAstGrep({ pattern: "x", paths: ["sample.ts"], language: "unknown" }, { cwd: f.root })).rejects.toThrow(/unsupported language/);
			await expect(executeAstGrep({ pattern: "x", paths: ["sample.ts"], strictness: "unsafe" }, { cwd: f.root })).rejects.toThrow(/strictness/);
			const result = await executeAstGrep({ pattern: "x", paths: ["sample.ts"], language: "TypeScript" }, { cwd: f.root, exec: async () => noMatches });
			expect(result).toMatchObject({ matchCount: 0, languages: ["typescript"], diagnostics: [] });
		} finally { f.dispose(); }
	});

	it("keeps valid matches with diagnostics and caps result output", async () => {
		const f = fixture();
		try {
			const stdout = Array.from({ length: 3 }, (_, line) => JSON.stringify({
				file: "sample.ts", text: "x", range: { start: { line, column: 0 }, end: { line, column: 1 } },
			})).join("\n");
			const result = await executeAstGrep({ pattern: "x", language: "typescript" }, {
				cwd: f.root, maxMatches: 2,
				exec: async () => ({ exitCode: 0, stdout, stderr: `${path.join(f.root, "sample.ts")}: parse error` }),
			});
			expect(result).toMatchObject({ matchCount: 2, truncated: true, diagnostics: [{ file: "sample.ts", message: expect.stringContaining("parse error") }] });
		} finally { f.dispose(); }
	});

	it("surfaces startup, all-language parse, and cancellation failures", async () => {
		const f = fixture();
		try {
			await expect(executeAstGrep({ pattern: "x", language: "typescript" }, { cwd: f.root, exec: async () => ({ ...noMatches, exitCode: null, spawnError: "ENOENT" }) })).rejects.toThrow(/could not start/);
			await expect(executeAstGrep({ pattern: "x", language: "typescript" }, { cwd: f.root, exec: async () => ({ exitCode: 1, stdout: "", stderr: "parse failure" }) })).rejects.toThrow(/could not parse/);
			const controller = new AbortController();
			controller.abort();
			await expect(executeAstGrep({ pattern: "x", language: "typescript" }, { cwd: f.root, exec: async (_f, _a, options) => ({ ...noMatches, timedOut: options.signal?.aborted }) }, controller.signal)).rejects.toThrow(/timed out/);
		} finally { f.dispose(); }
	});
});

import { spawnSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { detectAstGrepLanguages } from "../../lib/language-matrix.ts";
import { executeAstGrep } from "./ast-grep-runner.ts";

/** Probe the staged/PATH binary before registering: unsupported sessions stay inert. */
export function astGrepAvailable(cwd: string): boolean {
	try {
		const result = spawnSync("sg", ["--version"], { cwd, shell: false, stdio: "ignore", timeout: 2_000 });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

export const createAstGrepExtension = (
	available: (cwd: string) => boolean = astGrepAvailable,
	detect: (roots: readonly string[]) => string[] = detectAstGrepLanguages,
): ExtensionFactory => (pi) => {
	const cwd = process.env.BOBBIT_CWD || process.cwd();
	try {
		if (!available(cwd) || detect([cwd]).length === 0) return;
	} catch {
		return;
	}
	pi.registerTool({
		name: "ast_grep",
		label: "AST Grep",
		description: "Search syntax trees read-only. Prefer grep for text/regex and read for a known file.",
		promptSnippet: "ast_grep: Read-only syntax-aware search; use grep for plain text and read for source context.",
		promptGuidelines: [
			"Use ast_grep for syntax-aware patterns such as console.log($$$ARGS), never for edits.",
			"Use grep for plain text, regex, or broad discovery; use read for a small known file or source context.",
			"Patterns must parse in the selected language. Results are relative to the session working directory.",
		],
		parameters: Type.Object({
			paths: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: "Relative files or directories. Defaults to the working directory." })),
			pattern: Type.String({ description: "Required syntax pattern; must parse in the selected language." }),
			language: Type.Optional(Type.String({ description: "Optional supported language alias; detected when omitted." })),
			strictness: Type.Optional(Type.String({ description: "Match mode: cst, smart, ast, relaxed, signature, or template." })),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await executeAstGrep(params as any, { cwd }, signal);
				return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				return { isError: true, content: [{ type: "text" as const, text: `error: ${message}` }], details: undefined };
			}
		},
	});
};

export default createAstGrepExtension();

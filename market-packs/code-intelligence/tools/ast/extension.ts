import { spawnSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { detectAstGrepLanguages } from "../../lib/language-matrix.ts";
import { executeAstGrep } from "./ast-grep-runner.ts";

/**
 * Direct host sessions receive the resolver-verified absolute binary path.
 * Docker intentionally does not inherit it: its image-local `sg` remains the
 * fallback, so a host path can never leak into a container command.
 */
export function resolveAstGrepBinary(): string {
	return process.env.BOBBIT_AST_GREP_PATH || "sg";
}

/** Probe the resolver-selected/PATH binary before registering: unsupported sessions stay inert. */
export function astGrepAvailable(cwd: string, binary = resolveAstGrepBinary()): boolean {
	try {
		const result = spawnSync(binary, ["--version"], { cwd, shell: false, stdio: "ignore", timeout: 2_000 });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

export const createAstGrepExtension = (
	available: (cwd: string) => boolean = astGrepAvailable,
	detect: (roots: readonly string[]) => string[] = detectAstGrepLanguages,
	binaryForSession: () => string = resolveAstGrepBinary,
	run: typeof executeAstGrep = executeAstGrep,
): ExtensionFactory => (pi) => {
	const cwd = process.env.BOBBIT_CWD || process.cwd();
	const binary = binaryForSession();
	try {
		if (!available(cwd) || detect([cwd]).length === 0) return;
	} catch {
		return;
	}
	pi.registerTool({
		name: "ast_grep",
		label: "AST Grep",
		description: "Read-only structural search; read cited source and callers before review findings or approval.",
		promptSnippet: "ast_grep: Read-only structural leads; read cited source and callers before findings or approval.",
		promptGuidelines: [
			"Use ast_grep for syntax-aware patterns such as console.log($$$ARGS), never for edits.",
			"Use grep for plain text, regex, or broad discovery; use read for a small known file or source context.",
			"Before a finding or approval, use read on every cited source and caller; matches are leads, not proof.",
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
				const result = await run(params as any, { cwd, binary }, signal);
				return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				return { isError: true, content: [{ type: "text" as const, text: `error: ${message}` }], details: undefined };
			}
		},
	});
};

export default createAstGrepExtension();

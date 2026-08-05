import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	detectAstGrepLanguages,
	languagesForExtension,
	normalizeAstGrepLanguage,
	type AstGrepLanguageAlias,
} from "./ast-grep-languages.ts";

const MAX_PATHS = 32;
const MAX_MATCHES = 200;
const MAX_DIAGNOSTICS = 50;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export const AST_GREP_STRICTNESS = ["cst", "smart", "ast", "relaxed", "signature", "template"] as const;
export type AstGrepStrictness = (typeof AST_GREP_STRICTNESS)[number];

export interface AstGrepInput {
	paths?: string[];
	pattern: string;
	language?: string;
	strictness?: string;
}

export interface AstGrepMatch {
	file: string;
	range: { start: { line: number; column: number }; end: { line: number; column: number } };
	line: number;
	text: string;
	metaVariables: Record<string, unknown>;
}

export interface AstGrepResult {
	matches: AstGrepMatch[];
	matchCount: number;
	truncated: boolean;
	languages: AstGrepLanguageAlias[];
	diagnostics: Array<{ file?: string; message: string }>;
}

export interface AstGrepFs {
	realpathSync: typeof fs.realpathSync;
	lstatSync: typeof fs.lstatSync;
	accessSync: typeof fs.accessSync;
}

export interface AstGrepExecOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs: number;
	maxOutputBytes: number;
}

export interface AstGrepExecResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	outputTruncated?: boolean;
	spawnError?: string;
}

export type AstGrepExecutor = (file: string, args: readonly string[], options: AstGrepExecOptions) => Promise<AstGrepExecResult>;

export interface AstGrepRunnerOptions {
	cwd?: string;
	binary?: string;
	fs?: AstGrepFs;
	exec?: AstGrepExecutor;
	detectLanguages?: (roots: readonly string[]) => AstGrepLanguageAlias[];
	timeoutMs?: number;
	maxMatches?: number;
	maxDiagnostics?: number;
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toRelativePath(root: string, candidate: string): string {
	return path.relative(root, candidate).split(path.sep).join("/") || ".";
}

function error(message: string): never { throw new Error(message); }

function validatePaths(input: string[] | undefined, cwd: string, seams: AstGrepFs): string[] {
	const requested = input ?? ["."];
	if (!Array.isArray(requested) || requested.length === 0 || requested.length > MAX_PATHS) {
		error(`paths must contain between 1 and ${MAX_PATHS} relative entries`);
	}
	const root = seams.realpathSync(cwd);
	return requested.map((value) => {
		if (typeof value !== "string" || !value.trim()) error("paths must contain non-empty strings");
		if (path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) error(`path must be relative and cannot traverse: ${value}`);
		const unresolved = path.resolve(root, value);
		let stat: fs.Stats;
		try {
			stat = seams.lstatSync(unresolved);
			if (stat.isSymbolicLink()) error(`symlink paths are not supported: ${value}`);
			seams.accessSync(unresolved, fs.constants.R_OK);
		} catch (cause) {
			if (cause instanceof Error && cause.message.startsWith("symlink paths")) throw cause;
			error(`path is inaccessible: ${value}`);
		}
		let canonical: string;
		try { canonical = seams.realpathSync(unresolved); } catch { error(`path is inaccessible: ${value}`); }
		if (!isInside(root, canonical)) error(`path escapes the working directory: ${value}`);
		if (!stat.isDirectory() && !stat.isFile()) error(`unsupported path type: ${value}`);
		if (stat.isFile() && languagesForExtension(path.extname(canonical)).length === 0) {
			error(`unsupported source file: ${value}`);
		}
		return canonical;
	});
}

function parseDiagnostic(stderr: string, root: string, limit: number): Array<{ file?: string; message: string }> {
	const diagnostics: Array<{ file?: string; message: string }> = [];
	for (const rawLine of stderr.split(/\r?\n/)) {
		const message = rawLine.trim();
		if (!message || diagnostics.length >= limit) continue;
		const absolute = message.match(/(?:^|\s)(\/[^:\s]+|[A-Za-z]:\\[^:\s]+):/);
		let file: string | undefined;
		if (absolute) {
			const candidate = absolute[1];
			try {
				const canonical = fs.realpathSync(candidate);
				if (isInside(root, canonical)) file = toRelativePath(root, canonical);
			} catch {
				if (isInside(root, candidate)) file = toRelativePath(root, candidate);
			}
		}
		diagnostics.push({ ...(file ? { file } : {}), message: message.slice(0, 500) });
	}
	return diagnostics;
}

function normalizeMatch(record: any, root: string): AstGrepMatch | undefined {
	if (!record || typeof record !== "object" || typeof record.file !== "string" || !record.range) return undefined;
	const absolute = path.isAbsolute(record.file) ? record.file : path.resolve(root, record.file);
	if (!isInside(root, absolute)) return undefined;
	const start = record.range.start;
	const end = record.range.end;
	if (!start || !end || !Number.isInteger(start.line) || !Number.isInteger(start.column) || !Number.isInteger(end.line) || !Number.isInteger(end.column)) return undefined;
	return {
		file: toRelativePath(root, absolute),
		range: { start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column } },
		line: start.line + 1,
		text: typeof record.text === "string" ? record.text : (typeof record.lines === "string" ? record.lines : ""),
		metaVariables: record.metaVariables && typeof record.metaVariables === "object" ? record.metaVariables : {},
	};
}

export async function executeAstGrep(
	input: AstGrepInput,
	options: AstGrepRunnerOptions = {},
	signal?: AbortSignal,
): Promise<AstGrepResult> {
	const cwd = options.cwd ?? process.env.BOBBIT_CWD ?? process.cwd();
	const seams = options.fs ?? fs;
	const pattern = typeof input.pattern === "string" ? input.pattern : "";
	if (!pattern.trim()) error("pattern must be a non-empty string");
	const strictness = input.strictness ?? "smart";
	if (!(AST_GREP_STRICTNESS as readonly string[]).includes(strictness)) error(`strictness must be one of: ${AST_GREP_STRICTNESS.join(", ")}`);
	const paths = validatePaths(input.paths, cwd, seams);
	const root = seams.realpathSync(cwd);
	const requestedLanguage = typeof input.language === "string" ? normalizeAstGrepLanguage(input.language) : undefined;
	if (input.language !== undefined && !requestedLanguage) error(`unsupported language: ${String(input.language)}`);
	const languages = requestedLanguage ? [requestedLanguage.alias] : (options.detectLanguages ?? detectAstGrepLanguages)(paths);
	if (languages.length === 0) error("no supported source languages were found in paths");

	const exec = options.exec ?? spawnAstGrep;
	const matches: AstGrepMatch[] = [];
	const diagnostics: Array<{ file?: string; message: string }> = [];
	let truncated = false;
	let successfulLanguage = false;
	const maxMatches = options.maxMatches ?? MAX_MATCHES;
	const maxDiagnostics = options.maxDiagnostics ?? MAX_DIAGNOSTICS;
	for (const alias of languages) {
		const language = normalizeAstGrepLanguage(alias)!;
		const args = ["run", "--pattern", pattern, "--lang", language.cliLanguage, "--strictness", strictness, "--json=stream", "--color", "never", "--heading", "never", ...paths.map((entry) => toRelativePath(root, entry))];
		const result = await exec(options.binary ?? "sg", args, { cwd: root, signal, timeoutMs: options.timeoutMs ?? TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
		if (result.spawnError) error(`ast-grep could not start: ${result.spawnError}`);
		if (result.timedOut) error("ast-grep timed out");
		if (result.outputTruncated) truncated = true;
		const currentDiagnostics = parseDiagnostic(result.stderr, root, Math.max(0, maxDiagnostics - diagnostics.length));
		diagnostics.push(...currentDiagnostics);
		let parsedAny = false;
		for (const line of result.stdout.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const match = normalizeMatch(JSON.parse(line), root);
				if (!match) continue;
				parsedAny = true;
				if (matches.length < maxMatches) matches.push(match); else truncated = true;
			} catch { truncated = true; }
		}
		if (result.exitCode === 0 || parsedAny) successfulLanguage = true;
		if (result.exitCode !== 0 && currentDiagnostics.length === 0) {
			error(`ast-grep failed for ${alias} (exit ${result.exitCode})`);
		}
	}
	if (!successfulLanguage) error("ast-grep could not parse the selected languages");
	return { matches, matchCount: matches.length, truncated, languages, diagnostics };
}

/** Spawn the maintained CLI without a shell, with bounded output and cancellation. */
export function spawnAstGrep(file: string, args: readonly string[], options: AstGrepExecOptions): Promise<AstGrepExecResult> {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let outputTruncated = false;
		let timedOut = false;
		const child = spawn(file, [...args], { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (result: AstGrepExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			if (bytes >= options.maxOutputBytes) { outputTruncated = true; return; }
			const text = chunk.toString("utf8");
			const available = options.maxOutputBytes - bytes;
			const value = text.slice(0, available);
			bytes += Buffer.byteLength(value);
			if (value.length < text.length) outputTruncated = true;
			if (target === "stdout") stdout += value; else stderr += value;
		};
		child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
		const abort = () => child.kill("SIGTERM");
		if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
		child.once("error", (cause) => finish({ exitCode: null, stdout, stderr, spawnError: cause.message, timedOut, outputTruncated }));
		child.once("close", (exitCode) => finish({ exitCode, stdout, stderr, timedOut, outputTruncated }));
	});
}

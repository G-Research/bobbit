import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	detectAstGrepLanguages,
	languagesForExtension,
	normalizeAstGrepLanguage,
	type AstGrepLanguageAlias,
} from "../../lib/language-matrix.ts";

const MAX_PATHS = 32;
const MAX_MATCHES = 200;
const MAX_DIAGNOSTICS = 50;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 250;

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
	aborted?: boolean;
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

const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s:()[\]{}'\"]+/g;

/** Keep useful in-worktree locations while never returning host/container topology. */
function redactDiagnosticPaths(message: string, root: string, seams: AstGrepFs): { message: string; file?: string } {
	let file: string | undefined;
	const normalized = message.replace(ABSOLUTE_PATH, (candidate: string) => {
		let canonical = candidate;
		try { canonical = seams.realpathSync(candidate); } catch { /* preserve lexical containment check below */ }
		if (!isInside(root, canonical)) return "[redacted path]";
		const relative = toRelativePath(root, canonical);
		file ??= relative;
		return relative;
	});
	return { message: normalized, ...(file ? { file } : {}) };
}

function parseDiagnostic(stderr: string, root: string, seams: AstGrepFs, limit: number): {
	diagnostics: Array<{ file?: string; message: string }>;
	truncated: boolean;
} {
	const diagnostics: Array<{ file?: string; message: string }> = [];
	let truncated = false;
	for (const rawLine of stderr.split(/\r?\n/)) {
		const message = rawLine.trim();
		if (!message) continue;
		if (diagnostics.length >= limit) {
			truncated = true;
			continue;
		}
		const normalized = redactDiagnosticPaths(message, root, seams);
		diagnostics.push({ ...normalized, message: normalized.message.slice(0, 500) });
	}
	return { diagnostics, truncated };
}

function boundedOption(value: number | undefined, fallback: number, maximum: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) error(`${name} must be a positive integer`);
	return Math.min(value, maximum);
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
	if (signal?.aborted) error("ast-grep cancelled");
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
	const languages: AstGrepLanguageAlias[] = requestedLanguage
		? [requestedLanguage.id]
		: (options.detectLanguages ?? detectAstGrepLanguages)(paths);
	if (languages.length === 0) error("no supported source languages were found in paths");

	const exec = options.exec ?? spawnAstGrep;
	const matches: AstGrepMatch[] = [];
	const diagnostics: Array<{ file?: string; message: string }> = [];
	let truncated = false;
	let successfulLanguage = false;
	const maxMatches = boundedOption(options.maxMatches, MAX_MATCHES, MAX_MATCHES, "maxMatches");
	const maxDiagnostics = boundedOption(options.maxDiagnostics, MAX_DIAGNOSTICS, MAX_DIAGNOSTICS, "maxDiagnostics");
	const timeoutMs = boundedOption(options.timeoutMs, TIMEOUT_MS, TIMEOUT_MS, "timeoutMs");
	for (const alias of languages) {
		if (signal?.aborted) error("ast-grep cancelled");
		const language = normalizeAstGrepLanguage(alias)!;
		// ast-grep 0.39.5 accepts search paths after `--`; this prevents a path
		// such as `--follow` from becoming a CLI option with broader access.
		const args = ["run", "--pattern", pattern, "--lang", language.ast.grammar, "--strictness", strictness, "--json=stream", "--color", "never", "--heading", "never", "--", ...paths.map((entry) => toRelativePath(root, entry))];
		const result = await exec(options.binary ?? "sg", args, { cwd: root, signal, timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
		if (result.spawnError) error(`ast-grep could not start: ${redactDiagnosticPaths(result.spawnError, root, seams).message}`);
		if (result.aborted || signal?.aborted) error("ast-grep cancelled");
		if (result.timedOut) error("ast-grep timed out");
		if (result.outputTruncated) truncated = true;
		const currentDiagnostics = parseDiagnostic(result.stderr, root, seams, Math.max(0, maxDiagnostics - diagnostics.length));
		diagnostics.push(...currentDiagnostics.diagnostics);
		if (currentDiagnostics.truncated) truncated = true;
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
		const emptyNoMatch = result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim();
		if (result.exitCode === 0 || parsedAny || emptyNoMatch) successfulLanguage = true;
		if (result.exitCode !== 0 && !emptyNoMatch && currentDiagnostics.diagnostics.length === 0) {
			error(`ast-grep failed for ${alias} (exit ${result.exitCode})`);
		}
	}
	if (!successfulLanguage) {
		const summary = diagnostics.map(({ message }) => message).join("; ").slice(0, 500);
		error(`ast-grep could not parse the selected languages${summary ? `: ${summary}` : ""}`);
	}
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
		let aborted = false;
		let terminationTimer: NodeJS.Timeout | undefined;
		const child = spawn(file, [...args], { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (result: AstGrepExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (terminationTimer) clearTimeout(terminationTimer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
			if (bytes >= options.maxOutputBytes) { outputTruncated = true; return; }
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const value = buffer.subarray(0, options.maxOutputBytes - bytes);
			bytes += value.byteLength;
			if (value.byteLength < buffer.byteLength) outputTruncated = true;
			if (target === "stdout") stdout += value.toString("utf8"); else stderr += value.toString("utf8");
		};
		const terminate = (reason: "abort" | "timeout") => {
			if (settled || terminationTimer) return;
			if (reason === "abort") aborted = true; else timedOut = true;
			child.kill("SIGTERM");
			terminationTimer = setTimeout(() => {
				child.kill("SIGKILL");
				finish({ exitCode: null, stdout, stderr, timedOut, aborted, outputTruncated });
			}, TERMINATION_GRACE_MS);
		};
		child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
		const abort = () => terminate("abort");
		if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
		child.once("error", (cause) => finish({ exitCode: null, stdout, stderr, spawnError: cause.message, timedOut, aborted, outputTruncated }));
		child.once("close", (exitCode) => finish({ exitCode, stdout, stderr, timedOut, aborted, outputTruncated }));
	});
}

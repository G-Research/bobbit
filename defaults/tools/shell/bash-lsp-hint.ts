/**
 * Heuristic: when a `bash` command's top-level invocation is a grep-like
 * tool (`grep`, `rg`, `ripgrep`, `ag`, `ack`) searching for a TS/JS source
 * symbol AND the command produced output, prepend the same `[lsp-hint]`
 * line that the first-class `grep` tool emits.
 *
 * Pure module — no I/O — so it can be unit-tested with synthetic inputs.
 * Shares the symbol-shape detector and hint builder with the grep tool's
 * hint via `defaults/tools/_builtins/grep-lsp-hint.ts`.
 *
 * Disable via env: `BOBBIT_GREP_LSP_HINT=0` (same switch as grep tool).
 */

import {
	globIsTsJs,
	lspHintFor,
	type GrepLikeResult,
} from "../_builtins/grep-lsp-hint.js";

const GREP_LIKE_COMMANDS = new Set(["grep", "rg", "ripgrep", "ag", "ack"]);

/** Long/short flags that consume a separate value token. */
const FLAGS_WITH_VALUE = new Set([
	"-e", "--regexp",
	"-f", "--file",
	"--include", "--exclude",
	"--include-dir", "--exclude-dir", "--exclude-from",
	"-g", "--glob", "--iglob",
	"-t", "--type", "-T", "--type-not",
	"-A", "--after-context",
	"-B", "--before-context",
	"-C", "--context",
	"-m", "--max-count",
	"--color", "--colour",
]);

interface Token {
	value: string;
	/** True if any portion of the token came from inside quotes. */
	hadQuotes: boolean;
}

/**
 * Cheap shell tokenizer. Splits on whitespace, respects `'...'` and `"..."`
 * quoting (content preserved verbatim — escapes inside quotes are NOT
 * processed; agents typically write `"foo\("` meaning the regex literal),
 * and recognises the operator characters `|`, `&`, `;` as boundaries.
 *
 * Returns an array; operator tokens use the operator string itself as the
 * value (e.g. `|`, `||`, `&&`, `;`).
 */
export function tokenizeShell(command: string): Token[] {
	const out: Token[] = [];
	let i = 0;
	const n = command.length;
	while (i < n) {
		const c = command[i];
		if (c === " " || c === "\t" || c === "\n") { i++; continue; }
		if (c === "|" || c === "&" || c === ";") {
			let op = c;
			if (command[i + 1] === c) { op += c; i++; }
			out.push({ value: op, hadQuotes: false });
			i++;
			continue;
		}
		// Word — may contain quoted segments and unquoted characters.
		let val = "";
		let hadQuotes = false;
		while (i < n) {
			const ch = command[i];
			if (ch === " " || ch === "\t" || ch === "\n") break;
			if (ch === "|" || ch === "&" || ch === ";") break;
			if (ch === "\\" && i + 1 < n) {
				val += command[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"' || ch === "'") {
				hadQuotes = true;
				const quote = ch;
				i++;
				while (i < n && command[i] !== quote) {
					val += command[i];
					i++;
				}
				if (i < n) i++; // skip closing quote
				continue;
			}
			val += ch;
			i++;
		}
		out.push({ value: val, hadQuotes });
	}
	return out;
}

interface ParsedGrep {
	command: string;
	pattern: string | undefined;
	targets: string[];
}

/** `NAME=value` style simple env assignment (unquoted, valid identifier). */
function isEnvAssignment(tok: Token): boolean {
	if (tok.hadQuotes) return false;
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.value);
}

/**
 * Split a token stream into top-level command segments on `&&` and `;`
 * only. Returns null if any hard-stop operator (`||`, `&`) appears — those
 * indicate control flow we don't want to reason about best-effort.
 */
function splitSimpleChain(tokens: Token[]): Token[][] | null {
	const segments: Token[][] = [];
	let current: Token[] = [];
	for (const t of tokens) {
		if (t.hadQuotes) { current.push(t); continue; }
		if (t.value === "||" || t.value === "&") return null;
		if (t.value === "&&" || t.value === ";") {
			segments.push(current);
			current = [];
			continue;
		}
		current.push(t);
	}
	segments.push(current);
	return segments;
}

/**
 * True if the segment is setup-only (cd, set, or only env assignments)
 * and should be skipped while walking a simple chain.
 */
function isSetupSegment(segment: Token[]): boolean {
	if (segment.length === 0) return true;
	// All-env-assignments segment (`FOO=1 BAR=2`).
	if (segment.every(isEnvAssignment)) return true;
	const head = segment[0];
	if (head.hadQuotes) return false;
	if (head.value === "cd" || head.value === "set") return true;
	return false;
}

/** Truncate a segment at the first top-level pipe. */
function truncateAtPipe(segment: Token[]): Token[] {
	const out: Token[] = [];
	for (const t of segment) {
		if (!t.hadQuotes && t.value === "|") break;
		out.push(t);
	}
	return out;
}

/** Drop leading simple env-assignment tokens (`FOO=1 grep ...`). */
function stripLeadingEnv(segment: Token[]): Token[] {
	let i = 0;
	while (i < segment.length && isEnvAssignment(segment[i])) i++;
	return segment.slice(i);
}

/**
 * Identify whether a top-level command in a simple chain is a grep-like
 * invocation, and if so parse out its pattern and target paths/globs.
 *
 * Walks segments split by `&&` / `;`, skipping setup-only segments
 * (`cd <path>`, `set ...`, bare env assignments) and stripping leading
 * env assignments before inspecting the command. Returns the first
 * grep-like match found, or null.
 *
 * NOT matched: pipe-only filters like `cat foo | grep bar` because the
 * pipe truncation keeps only the primary command of each segment.
 */
export function parseTopLevelGrep(command: string): ParsedGrep | null {
	const tokens = tokenizeShell(command);
	if (tokens.length === 0) return null;

	const segments = splitSimpleChain(tokens);
	if (!segments) return null;

	for (const raw of segments) {
		if (isSetupSegment(raw)) continue;
		const stripped = stripLeadingEnv(raw);
		if (stripped.length === 0) continue;
		if (isSetupSegment(stripped)) continue;
		const segment = truncateAtPipe(stripped);
		if (segment.length === 0) continue;

		const head = segment[0];
		if (head.hadQuotes) continue;
		const cmdName = head.value;
		if (!GREP_LIKE_COMMANDS.has(cmdName)) {
			// Not grep-like; stop — only walk through pure setup prefix.
			return null;
		}

		return parseGrepArgs(cmdName, segment.slice(1));
	}
	return null;
}

function parseGrepArgs(cmdName: string, args: Token[]): ParsedGrep {
	let patternFromFlag: string | undefined;
	const globsFromFlag: string[] = [];
	const positionals: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const v = a.value;
		// Long flag with `=` form. We allow this branch even if the token
		// crossed a quote boundary, because agents commonly write
		// `--include='*.ts'` / `--regexp="foo"` and the tokenizer merges
		// the unquoted flag prefix with the quoted value into a single
		// token whose `hadQuotes` flag is true.
		if (v.startsWith("--") && v.includes("=")) {
			const eq = v.indexOf("=");
			const flag = v.slice(0, eq);
			const val = v.slice(eq + 1);
			if (flag === "--regexp") {
				patternFromFlag = patternFromFlag ?? val;
			} else if (flag === "--include" || flag === "--glob" || flag === "--iglob") {
				globsFromFlag.push(val);
			}
			continue;
		}
		if (a.hadQuotes) {
			positionals.push(v);
			continue;
		}
		// Flag taking a separate value
		if (FLAGS_WITH_VALUE.has(v)) {
			const next = args[i + 1];
			if (!next) break;
			i++;
			if (v === "-e" || v === "--regexp") {
				patternFromFlag = patternFromFlag ?? next.value;
			} else if (v === "-g" || v === "--glob" || v === "--iglob" || v === "--include") {
				globsFromFlag.push(next.value);
			}
			continue;
		}
		// Other flag (boolean / bundled short / unrecognised long) — skip.
		if (v.startsWith("-") && v.length > 1) continue;
		positionals.push(v);
	}

	const pattern = patternFromFlag ?? positionals.shift();
	return {
		command: cmdName,
		pattern,
		targets: [...globsFromFlag, ...positionals],
	};
}


const PY_EXT_RE = /(?<![A-Za-z0-9_])py(?![A-Za-z0-9_])/;

/**
 * True if a positional path / glob arg targets TS/JS/Py source territory.
 *
 * - A directory path (no extension, no wildcard) → true.
 * - A glob/path with an extension or wildcard → delegate to `globIsTsJs`
 *   and also accept `.py` per the design doc.
 */
function targetIsSource(target: string): boolean {
	const isGlobish = /[*?[\]{}]/.test(target) || /\.[A-Za-z0-9]+$/.test(target);
	if (!isGlobish) return true;
	if (globIsTsJs(target)) return true;
	if (PY_EXT_RE.test(target)) return true;
	return false;
}

// Lines like `grep: foo.ts: No such file or directory` produced by the
// grep family on its stderr. We must NOT treat error-only output as
// grep matches worth annotating with an LSP hint.
const GREP_ERROR_LINE_RE = /^(?:grep|rg|ripgrep|ag|ack):\s/;

function bashHasOutput(result: GrepLikeResult | undefined | null): boolean {
	if (!result) return false;
	if ((result as GrepLikeResult).isError === true) return false;
	const content = result.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	for (const item of content) {
		if (!item || item.type !== "text") continue;
		const text = typeof item.text === "string" ? item.text : "";
		// The bash tool prefixes output with "Exit code: N\n" — strip that
		// before deciding whether grep itself produced anything.
		const stripped = text.replace(/^Exit code:\s*\S+\s*\n?/, "").trim();
		if (stripped.length === 0) continue;
		// If every remaining non-empty line is a grep/rg error message,
		// treat it as no output. Otherwise we'd misleadingly prepend an
		// `[lsp-hint]` to a failed search.
		const lines = stripped.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
		if (lines.length > 0 && lines.every(l => GREP_ERROR_LINE_RE.test(l))) continue;
		return true;
	}
	return false;
}

/**
 * Compute the LSP hint for a bash command, or null when no hint applies.
 */
export function lspHintForBashCommand(
	command: string,
	result: GrepLikeResult | undefined | null,
): string | null {
	if (process.env.BOBBIT_GREP_LSP_HINT === "0") return null;
	if (!command || typeof command !== "string") return null;
	const parsed = parseTopLevelGrep(command);
	if (!parsed || !parsed.pattern) return null;

	const sourceTarget =
		parsed.targets.length === 0 ? true : parsed.targets.some(targetIsSource);
	if (!sourceTarget) return null;

	if (!bashHasOutput(result)) return null;

	// Reuse the grep-tool hint builder so the wording stays in one place.
	// We do not pass a `glob` because we've already vetted source-target
	// above; bare `lspHintFor` only needs the pattern + a "has output" cue.
	const wrappedResult: GrepLikeResult = {
		content: [{ type: "text", text: "x" }],
	};
	return lspHintFor({ pattern: parsed.pattern }, wrappedResult);
}

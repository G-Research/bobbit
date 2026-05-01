/**
 * Server-side on-disk lifecycle for editable proposal drafts.
 *
 * Path: `<stateDir>/proposal-drafts/<sessionId>/<type>.<ext>` where `<ext>` is
 * `md` for goal proposals and `yaml` for everything else.
 *
 * This module is intentionally narrow: read/write/edit/parse/delete.
 * No imports from session-manager, ws, or any agent runtime — the caller
 * (REST handlers, tool extension) is responsible for parsing payloads and
 * broadcasting WebSocket events.
 *
 * Design doc: docs/design/editable-proposals.md §3, §4.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { getProposalTypePlugin, type ProposalTypePlugin } from "./proposal-types.js";

export type ProposalType = "goal" | "project" | "role" | "tool" | "staff";

export interface TypedProposal {
	type: ProposalType;
	fields: Record<string, unknown>;
}

export type ParseErrorCode =
	| "FILE_NOT_FOUND"
	| "FRONTMATTER_MALFORMED"
	| "YAML_PARSE_ERROR"
	| "MISSING_REQUIRED_FIELD"
	| "STRUCTURAL_VALIDATION_FAILED";

export interface ParseError {
	ok: false;
	code: ParseErrorCode;
	message: string;
	line?: number;
	col?: number;
	field?: string;
}

export type ParseResult = { ok: true; value: TypedProposal } | ParseError;

export type EditErrorCode = "OLD_TEXT_NOT_FOUND" | "OLD_TEXT_NOT_UNIQUE";

export interface EditError {
	ok: false;
	code: EditErrorCode;
	message: string;
}

export interface EditSuccess {
	ok: true;
	newContent: string;
	parsed: TypedProposal;
}

export type EditResult = EditSuccess | ParseError | EditError;

export const PROPOSAL_TYPES: readonly ProposalType[] = [
	"goal",
	"project",
	"role",
	"tool",
	"staff",
] as const;

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isProposalType(s: string): s is ProposalType {
	return (PROPOSAL_TYPES as readonly string[]).includes(s);
}

function assertSafeSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw new Error(`Unsafe sessionId: ${JSON.stringify(sessionId)}`);
	}
}

function assertSafeType(type: string): asserts type is ProposalType {
	if (!isProposalType(type)) {
		throw new Error(`Unknown proposal type: ${JSON.stringify(type)}`);
	}
}

function dirFor(stateDir: string, sessionId: string): string {
	assertSafeSessionId(sessionId);
	return path.join(stateDir, "proposal-drafts", sessionId);
}

export function proposalFilePath(stateDir: string, sessionId: string, type: ProposalType): string {
	assertSafeSessionId(sessionId);
	assertSafeType(type);
	const plugin = getProposalTypePlugin(type);
	return path.join(stateDir, "proposal-drafts", sessionId, plugin.filename);
}

/**
 * Serialize and write a proposal file. Atomic via write-tmp + rename.
 * Always parses+validates the serialized form before rename — if validation
 * fails the on-disk file is untouched and the error is thrown to the caller.
 */
export async function writeProposalFile(
	stateDir: string,
	sessionId: string,
	type: ProposalType,
	fields: Record<string, unknown>,
): Promise<void> {
	assertSafeSessionId(sessionId);
	assertSafeType(type);
	const plugin = getProposalTypePlugin(type);
	const dir = dirFor(stateDir, sessionId);
	const filePath = path.join(dir, plugin.filename);
	const content = plugin.serialize(fields);
	await fsp.mkdir(dir, { recursive: true });
	const tmpPath = filePath + ".tmp";
	await fsp.writeFile(tmpPath, content, "utf8");
	// Validate the serialized form before commit.
	const parsed = plugin.parse(content);
	if (!parsed.ok) {
		await fsp.unlink(tmpPath).catch(() => {});
		const e = parsed as ParseError;
		throw new Error(`writeProposalFile validation failed [${e.code}]: ${e.message}`);
	}
	await fsp.rename(tmpPath, filePath);
}

/** Read raw file contents, or `undefined` if missing. */
export async function readProposalFile(
	stateDir: string,
	sessionId: string,
	type: ProposalType,
): Promise<string | undefined> {
	assertSafeSessionId(sessionId);
	assertSafeType(type);
	const filePath = proposalFilePath(stateDir, sessionId, type);
	try {
		return await fsp.readFile(filePath, "utf8");
	} catch (err: any) {
		if (err && err.code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * Exact-string replacement on the proposal file with atomic rollback.
 * Semantics mirror the builtin `edit` tool: `old_text` must match exactly
 * and uniquely; empty `new_text` deletes; first-and-only-occurrence rule.
 *
 * On parse/validation failure the on-disk file is left untouched.
 */
export async function editProposalFile(
	stateDir: string,
	sessionId: string,
	type: ProposalType,
	oldText: string,
	newText: string,
): Promise<EditResult> {
	assertSafeSessionId(sessionId);
	assertSafeType(type);
	const plugin = getProposalTypePlugin(type);
	const filePath = proposalFilePath(stateDir, sessionId, type);
	let current: string;
	try {
		current = await fsp.readFile(filePath, "utf8");
	} catch (err: any) {
		if (err && err.code === "ENOENT") {
			return {
				ok: false,
				code: "FILE_NOT_FOUND",
				message: `No ${type} proposal draft found. Call propose_${type} first.`,
			};
		}
		throw err;
	}

	const firstIdx = current.indexOf(oldText);
	if (firstIdx === -1) {
		return { ok: false, code: "OLD_TEXT_NOT_FOUND", message: "old_text not found in proposal" };
	}
	const secondIdx = current.indexOf(oldText, firstIdx + 1);
	if (secondIdx !== -1) {
		return {
			ok: false,
			code: "OLD_TEXT_NOT_UNIQUE",
			message: "old_text matches multiple locations; include more surrounding context",
		};
	}

	const next = current.slice(0, firstIdx) + newText + current.slice(firstIdx + oldText.length);

	// Atomic write with rollback: parse next; only rename .tmp on success.
	const tmpPath = filePath + ".tmp";
	await fsp.writeFile(tmpPath, next, "utf8");
	const parsed = plugin.parse(next);
	if (!parsed.ok) {
		await fsp.unlink(tmpPath).catch(() => {});
		return parsed;
	}
	await fsp.rename(tmpPath, filePath);
	return { ok: true, newContent: next, parsed: parsed.value };
}

/** Read + parse the proposal file via the per-type plugin. */
export async function parseProposalFile(
	stateDir: string,
	sessionId: string,
	type: ProposalType,
): Promise<ParseResult> {
	assertSafeSessionId(sessionId);
	assertSafeType(type);
	const plugin = getProposalTypePlugin(type);
	const content = await readProposalFile(stateDir, sessionId, type);
	if (content === undefined) {
		return {
			ok: false,
			code: "FILE_NOT_FOUND",
			message: `No ${type} proposal draft found.`,
		};
	}
	return plugin.parse(content);
}

/** Remove the proposal file. Idempotent. */
export async function deleteProposalFile(
	stateDir: string,
	sessionId: string,
	type: ProposalType,
): Promise<void> {
	assertSafeSessionId(sessionId);
	assertSafeType(type);
	const filePath = proposalFilePath(stateDir, sessionId, type);
	try {
		await fsp.unlink(filePath);
	} catch (err: any) {
		if (err && err.code === "ENOENT") return;
		throw err;
	}
}

/** Enumerate all proposal types for which a file currently exists. */
export async function listProposalFiles(
	stateDir: string,
	sessionId: string,
): Promise<ProposalType[]> {
	assertSafeSessionId(sessionId);
	const dir = dirFor(stateDir, sessionId);
	let entries: string[];
	try {
		entries = await fsp.readdir(dir);
	} catch (err: any) {
		if (err && err.code === "ENOENT") return [];
		throw err;
	}
	const out: ProposalType[] = [];
	for (const t of PROPOSAL_TYPES) {
		const plugin = getProposalTypePlugin(t);
		if (entries.includes(plugin.filename)) out.push(t);
	}
	return out;
}

export { getProposalTypePlugin };
export type { ProposalTypePlugin };

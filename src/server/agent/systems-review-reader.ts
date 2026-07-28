import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CommandRunner } from "../gateway-deps.js";
import {
	assertSystemsReviewReadablePath,
	isSystemsReviewBodyExemptPath,
	readSystemsReviewPatchRange,
	runSystemsReviewGit,
	SystemsReviewSnapshotError,
} from "./systems-review-snapshot.js";
import {
	SYSTEMS_REVIEW_READER_VERSION,
	type SystemsReviewChange,
	type SystemsReviewCoverageReadRecord,
	type SystemsReviewEligibleTargetAssertion,
	type SystemsReviewReadOperation,
	type SystemsReviewReadPage,
	type SystemsReviewReadRequest,
	type SystemsReviewReceiptClaims,
	type SystemsReviewRepoBinding,
	type SystemsReviewSnapshot,
	type SystemsReviewTreeSide,
} from "./systems-review-types.js";

export const SYSTEMS_REVIEW_MAX_PAGE_BYTES = 48 * 1024;
export const SYSTEMS_REVIEW_MAX_PAGE_RECORDS = 200;
export const SYSTEMS_REVIEW_MAX_CONTENT_BYTES = 40 * 1024;
export const SYSTEMS_REVIEW_READ_TIMEOUT_MS = 10_000;
export const SYSTEMS_REVIEW_SEARCH_MAX_QUERY_BYTES = 256;
export const SYSTEMS_REVIEW_SEARCH_MAX_PATHS = 50;
export const SYSTEMS_REVIEW_SEARCH_MAX_FILE_BYTES = 10 * 1024 * 1024;

interface CursorClaims {
	version: typeof SYSTEMS_REVIEW_READER_VERSION;
	kind: "cursor";
	sessionId: string;
	signalId: string;
	snapshotDigest: string;
	operation: SystemsReviewReadOperation;
	objectId: string;
	offset: number;
}

interface SignedReceiptEnvelope {
	kind: "receipt";
	claims: SystemsReviewReceiptClaims;
}

interface TreeEntry {
	mode: string;
	type: "blob" | "tree" | "commit";
	oid: string;
	path: string;
}

interface SearchRecord {
	path: string;
	line: number;
	column: number;
	text: string;
	blobOid: string;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function encodeSigned(prefix: "sr-c1" | "sr-r1", payload: unknown, secret: Buffer): string {
	const encoded = Buffer.from(stableJson(payload), "utf8").toString("base64url");
	const signature = createHmac("sha256", secret).update(`${prefix}.${encoded}`).digest("base64url");
	return `${prefix}.${encoded}.${signature}`;
}

function decodeSigned<T>(token: string, prefix: "sr-c1" | "sr-r1", secret: Buffer): T {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]) throw new SystemsReviewReaderError("INVALID_TOKEN", `Invalid Systems review ${prefix === "sr-c1" ? "cursor" : "receipt"}.`);
	const expected = createHmac("sha256", secret).update(`${prefix}.${parts[1]}`).digest();
	let supplied: Buffer;
	try { supplied = Buffer.from(parts[2], "base64url"); } catch { throw new SystemsReviewReaderError("INVALID_TOKEN", "Invalid Systems review token signature."); }
	if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new SystemsReviewReaderError("INVALID_TOKEN", "Systems review token signature mismatch.");
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as T;
	} catch {
		throw new SystemsReviewReaderError("INVALID_TOKEN", "Systems review token payload is malformed.");
	}
}

export class SystemsReviewReaderError extends Error {
	readonly code: string;
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "SystemsReviewReaderError";
		this.code = code;
		this.details = details;
	}
}

function checkedLimit(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new SystemsReviewReaderError("INVALID_LIMIT", `limit must be an integer from 1 to ${maximum}.`);
	return value;
}

function literalPathspec(candidate: string): string {
	return `:(literal)${candidate}`;
}

function repoFor(snapshot: SystemsReviewSnapshot, repoId: string): SystemsReviewRepoBinding {
	const repo = snapshot.repos.find(candidate => candidate.id === repoId);
	if (!repo) throw new SystemsReviewReaderError("UNKNOWN_REPO", `Unknown Systems review repository "${repoId}".`);
	return repo;
}

function treeFor(repo: SystemsReviewRepoBinding, side: SystemsReviewTreeSide): string {
	return side === "base" ? repo.mergeBaseTreeOid : repo.headTreeOid;
}

function parseTreeEntry(token: Buffer): TreeEntry {
	const tab = token.indexOf(0x09);
	if (tab < 0) throw new SystemsReviewReaderError("MALFORMED_TREE", "Git tree entry omitted its path separator.");
	const metadata = token.subarray(0, tab).toString("utf8").split(" ");
	const entryPath = token.subarray(tab + 1).toString("utf8");
	const [mode, type, oid] = metadata;
	if (!mode || (type !== "blob" && type !== "tree" && type !== "commit") || !oid) throw new SystemsReviewReaderError("MALFORMED_TREE", "Git returned a malformed tree entry.");
	return { mode, type, oid, path: entryPath };
}

function assertReadableTreeEntry(entry: TreeEntry): void {
	assertSystemsReviewReadablePath(entry.path);
	if (entry.mode === "120000") throw new SystemsReviewReaderError("SYMLINK_PATH", `Symlink path "${entry.path}" is not readable by Systems review.`);
	if (entry.mode === "160000" || entry.type === "commit") throw new SystemsReviewReaderError("SUBMODULE_PATH", `Submodule path "${entry.path}" is not readable by Systems review.`);
	if (entry.type !== "blob") throw new SystemsReviewReaderError("NOT_A_FILE", `Path "${entry.path}" is not a regular file.`);
}

export interface SystemsReviewReaderOptions {
	snapshot: SystemsReviewSnapshot;
	secret: Buffer | string;
	commandRunner?: CommandRunner;
	targetAssertions?: readonly (SystemsReviewEligibleTargetAssertion & { coverageItemId: string; executionId: string })[];
}

export class SystemsReviewDiffReader {
	readonly snapshot: SystemsReviewSnapshot;
	private readonly secret: Buffer;
	private readonly commandRunner?: CommandRunner;
	private readonly targetAssertions: readonly (SystemsReviewEligibleTargetAssertion & { coverageItemId: string; executionId: string })[];

	constructor(options: SystemsReviewReaderOptions) {
		this.snapshot = options.snapshot;
		this.secret = Buffer.isBuffer(options.secret) ? Buffer.from(options.secret) : Buffer.from(options.secret, "utf8");
		if (this.secret.byteLength < 32) throw new SystemsReviewReaderError("WEAK_SECRET", "Systems review cursor/receipt secret must contain at least 32 bytes.");
		this.commandRunner = options.commandRunner;
		this.targetAssertions = Object.freeze((options.targetAssertions ?? []).map(assertion => Object.freeze(structuredClone(assertion))));
	}

	verifyReceipt(token: string): SystemsReviewReceiptClaims {
		const envelope = decodeSigned<SignedReceiptEnvelope>(token, "sr-r1", this.secret);
		if (envelope?.kind !== "receipt" || !envelope.claims) throw new SystemsReviewReaderError("INVALID_RECEIPT", "Systems review receipt payload is malformed.");
		const claims = envelope.claims;
		if (claims.version !== SYSTEMS_REVIEW_READER_VERSION || claims.sessionId !== this.snapshot.sessionId || claims.signalId !== this.snapshot.signalId || claims.snapshotDigest !== this.snapshot.digest) {
			throw new SystemsReviewReaderError("RECEIPT_SCOPE_MISMATCH", "Systems review receipt belongs to a different session, signal, or snapshot.");
		}
		if (!Number.isSafeInteger(claims.start) || !Number.isSafeInteger(claims.end) || claims.start < 0 || claims.end < claims.start || !/^[0-9a-f]{64}$/.test(claims.contentSha256)) {
			throw new SystemsReviewReaderError("INVALID_RECEIPT", "Systems review receipt claims are malformed.");
		}
		return claims;
	}

	private offset(cursor: string | undefined, operation: SystemsReviewReadOperation, objectId: string): number {
		if (!cursor) return 0;
		const claims = decodeSigned<CursorClaims>(cursor, "sr-c1", this.secret);
		if (claims?.version !== SYSTEMS_REVIEW_READER_VERSION || claims.kind !== "cursor" || claims.sessionId !== this.snapshot.sessionId || claims.signalId !== this.snapshot.signalId || claims.snapshotDigest !== this.snapshot.digest || claims.operation !== operation || claims.objectId !== objectId || !Number.isSafeInteger(claims.offset) || claims.offset < 0) {
			throw new SystemsReviewReaderError("CURSOR_SCOPE_MISMATCH", "Systems review cursor does not match this session, signal, snapshot, operation, or object.");
		}
		return claims.offset;
	}

	private cursor(operation: SystemsReviewReadOperation, objectId: string, offset: number): string {
		return encodeSigned("sr-c1", {
			version: SYSTEMS_REVIEW_READER_VERSION,
			kind: "cursor",
			sessionId: this.snapshot.sessionId,
			signalId: this.snapshot.signalId,
			snapshotDigest: this.snapshot.digest,
			operation,
			objectId,
			offset,
		} satisfies CursorClaims, this.secret);
	}

	private page<T>(operation: SystemsReviewReadOperation, objectId: string, start: number, end: number, complete: boolean, data: T, binding: Partial<Pick<SystemsReviewReceiptClaims, "repoId" | "path" | "side">> = {}): SystemsReviewReadPage<T> {
		const claims: SystemsReviewReceiptClaims = {
			version: SYSTEMS_REVIEW_READER_VERSION,
			sessionId: this.snapshot.sessionId,
			signalId: this.snapshot.signalId,
			snapshotDigest: this.snapshot.digest,
			operation,
			objectId,
			...binding,
			start,
			end,
			complete,
			contentSha256: sha256(stableJson(data)),
		};
		const page: SystemsReviewReadPage<T> = {
			version: SYSTEMS_REVIEW_READER_VERSION,
			sessionId: this.snapshot.sessionId,
			signalId: this.snapshot.signalId,
			snapshotDigest: this.snapshot.digest,
			operation,
			objectId,
			range: { start, end, complete },
			data,
			receipt: encodeSigned("sr-r1", { kind: "receipt", claims } satisfies SignedReceiptEnvelope, this.secret),
			receiptClaims: claims,
			...(complete ? {} : { nextCursor: this.cursor(operation, objectId, end) }),
		};
		if (Buffer.byteLength(JSON.stringify(page), "utf8") > SYSTEMS_REVIEW_MAX_PAGE_BYTES) {
			throw new SystemsReviewReaderError("PAGE_LIMIT_EXCEEDED", "Systems review response exceeded the 48 KiB page limit.");
		}
		return page;
	}

	private recordsPage<T>(operation: SystemsReviewReadOperation, objectId: string, records: readonly T[], cursor: string | undefined, requestedLimit: number | undefined): SystemsReviewReadPage<T[]> {
		const start = this.offset(cursor, operation, objectId);
		if (start > records.length) throw new SystemsReviewReaderError("INVALID_CURSOR", "Systems review cursor starts beyond the bound record set.");
		const limit = checkedLimit(requestedLimit, SYSTEMS_REVIEW_MAX_PAGE_RECORDS, SYSTEMS_REVIEW_MAX_PAGE_RECORDS);
		const data: T[] = [];
		let end = start;
		while (end < records.length && data.length < limit) {
			const next = records[end];
			const candidateBytes = Buffer.byteLength(stableJson([...data, next]), "utf8");
			if (candidateBytes > SYSTEMS_REVIEW_MAX_CONTENT_BYTES) {
				if (data.length === 0) throw new SystemsReviewReaderError("OVERSIZED_RECORD", "A Systems review inventory record exceeds the bounded page size.");
				break;
			}
			data.push(next);
			end++;
		}
		return this.page(operation, objectId, start, end, end >= records.length, data);
	}

	async read(request: SystemsReviewReadRequest): Promise<SystemsReviewReadPage> {
		const started = Date.now();
		try {
			switch (request.operation) {
				case "repos": return this.readRepos(request.cursor, request.limit);
				case "manifest": return this.recordsPage("manifest", `manifest:${this.snapshot.digest}`, this.snapshot.changes, request.cursor, request.limit);
				case "coverage": return this.readCoverage(request.cursor, request.limit);
				case "patch": return await this.readPatch(request.changeId, request.cursor, request.limit);
				case "file": return await this.readFile(request.repoId, request.side, request.path, request.cursor, request.limit, started);
				case "list": return await this.readList(request.repoId, request.side, request.path, request.cursor, request.limit, started);
				case "search": return await this.readSearch(request.repoId, request.side, request.paths, request.query, request.cursor, request.limit, started);
			}
		} catch (error) {
			if (error instanceof SystemsReviewReaderError) throw error;
			if (error instanceof SystemsReviewSnapshotError) throw new SystemsReviewReaderError(error.code, error.message, error.details);
			throw error;
		}
	}

	private readRepos(cursor?: string, limit?: number): SystemsReviewReadPage {
		const records = this.snapshot.repos.map(({ root: _root, ...repo }) => repo);
		return this.recordsPage("repos", `repos:${this.snapshot.digest}`, records, cursor, limit);
	}

	private readCoverage(cursor?: string, limit?: number): SystemsReviewReadPage<SystemsReviewCoverageReadRecord[]> {
		const records: SystemsReviewCoverageReadRecord[] = this.snapshot.coverage.map(item => {
			const requiredAdapters = new Set(item.requiredTargetAdapterIds ?? []);
			const eligibleTargetAssertions = this.targetAssertions
				.filter(assertion => (
					assertion.coverageItemId === item.id
					&& assertion.adapterIds.length > 0
					&& assertion.adapterIds.every(adapterId => requiredAdapters.has(adapterId))
				))
				.map(assertion => ({
					assertionId: assertion.assertionId,
					actionId: assertion.actionId,
					commandId: assertion.commandId,
					testId: assertion.testId,
					testKind: assertion.testKind,
					baseOid: assertion.baseOid,
					headOid: assertion.headOid,
					expectedTarget: assertion.expectedTarget,
					expectedScope: assertion.expectedScope,
					effectOutcome: assertion.effectOutcome,
					adapterIds: [...assertion.adapterIds],
					effectKinds: [...assertion.effectKinds],
				}));
			return { ...structuredClone(item), eligibleTargetAssertions };
		});
		// Assertions are append-only, so bind cursors/receipts to this exact immutable
		// projection. If evidence appears between pages, the old cursor fails closed
		// and the reviewer restarts the bounded coverage read.
		const evidenceDigest = sha256(stableJson(records));
		return this.recordsPage("coverage", `coverage:${this.snapshot.digest}:${evidenceDigest}`, records, cursor, limit);
	}

	private async readPatch(changeId: string, cursor?: string, limit?: number): Promise<SystemsReviewReadPage> {
		const change = this.snapshot.changes.find(candidate => candidate.id === changeId);
		if (!change) throw new SystemsReviewReaderError("UNKNOWN_CHANGE", `Unknown Systems review change "${changeId}".`);
		const objectId = `patch:${change.id}:${change.patchSha256}`;
		const start = this.offset(cursor, "patch", objectId);
		if (change.bodyExempt) {
			if (start !== 0) throw new SystemsReviewReaderError("INVALID_CURSOR", "Body-exempt patch has no continuation range.");
			return this.page("patch", objectId, 0, 0, true, { binary: change.binary, bodyExempt: true, changeId: change.id, patchSha256: change.patchSha256 }, { repoId: change.repoId, path: change.newPath ?? change.oldPath });
		}
		const maxBytes = checkedLimit(limit, SYSTEMS_REVIEW_MAX_CONTENT_BYTES, SYSTEMS_REVIEW_MAX_CONTENT_BYTES);
		const range = await readSystemsReviewPatchRange(this.snapshot, change, start, maxBytes, this.commandRunner, SYSTEMS_REVIEW_READ_TIMEOUT_MS);
		return this.page("patch", objectId, start, range.end, range.complete, { encoding: "utf8", content: range.content.toString("utf8"), patchSha256: range.digest, totalBytes: range.totalBytes }, { repoId: change.repoId, path: change.newPath ?? change.oldPath });
	}

	private remainingTimeout(started: number): number {
		const remaining = SYSTEMS_REVIEW_READ_TIMEOUT_MS - (Date.now() - started);
		if (remaining <= 0) throw new SystemsReviewReaderError("READ_TIMEOUT", "Systems review read exceeded 10 seconds.");
		return remaining;
	}

	private async git(repo: SystemsReviewRepoBinding, args: readonly string[], started: number, onStdout?: (chunk: Buffer) => void): Promise<Buffer> {
		return runSystemsReviewGit(repo.root, args, this.commandRunner, onStdout, this.remainingTimeout(started));
	}

	private async exactTreeEntry(repo: SystemsReviewRepoBinding, side: SystemsReviewTreeSide, candidatePath: string, started: number): Promise<TreeEntry> {
		const safePath = assertSystemsReviewReadablePath(candidatePath);
		if (isSystemsReviewBodyExemptPath(safePath)) throw new SystemsReviewReaderError("BODY_EXEMPT_PATH", `Body-exempt asset or dependency lockfile "${safePath}" cannot be read or searched.`);
		const raw = await this.git(repo, ["-c", "core.quotepath=false", "ls-tree", "-z", treeFor(repo, side), "--", literalPathspec(safePath)], started);
		const tokens = raw.subarray(0, raw.at(-1) === 0 ? raw.length - 1 : raw.length).toString("binary");
		if (!tokens) throw new SystemsReviewReaderError("PATH_NOT_FOUND", `Path "${safePath}" does not exist in the bound ${side} tree.`);
		const entries = raw.toString("binary").split("\0").filter(Boolean).map(token => parseTreeEntry(Buffer.from(token, "binary")));
		const entry = entries.find(item => item.path === safePath);
		if (!entry) throw new SystemsReviewReaderError("PATH_NOT_FOUND", `Path "${safePath}" does not resolve to an exact bound-tree entry.`);
		assertReadableTreeEntry(entry);
		return entry;
	}

	private async blobSize(repo: SystemsReviewRepoBinding, oid: string, started: number): Promise<number> {
		const raw = (await this.git(repo, ["cat-file", "-s", oid], started)).toString("utf8").trim();
		const size = Number(raw);
		if (!Number.isSafeInteger(size) || size < 0) throw new SystemsReviewReaderError("INVALID_BLOB", `Git returned an invalid blob size for ${oid}.`);
		return size;
	}

	private async blobRange(repo: SystemsReviewRepoBinding, oid: string, start: number, maxBytes: number, expectedSize: number, started: number): Promise<Buffer> {
		const chunks: Buffer[] = [];
		let total = 0;
		let captured = 0;
		await this.git(repo, ["cat-file", "blob", oid], started, chunk => {
			const chunkStart = total;
			total += chunk.byteLength;
			if (captured >= maxBytes || chunkStart + chunk.byteLength <= start) return;
			const localStart = Math.max(0, start - chunkStart);
			const length = Math.min(chunk.byteLength - localStart, maxBytes - captured);
			if (length > 0) {
				chunks.push(chunk.subarray(localStart, localStart + length));
				captured += length;
			}
		});
		if (total !== expectedSize) throw new SystemsReviewReaderError("STALE_BLOB", `Bound blob ${oid} changed size while being read.`);
		return Buffer.concat(chunks);
	}

	private async readFile(repoId: string, side: SystemsReviewTreeSide, candidatePath: string, cursor: string | undefined, limit: number | undefined, started: number): Promise<SystemsReviewReadPage> {
		const repo = repoFor(this.snapshot, repoId);
		const safePath = assertSystemsReviewReadablePath(candidatePath);
		const entry = await this.exactTreeEntry(repo, side, safePath, started);
		const size = await this.blobSize(repo, entry.oid, started);
		const objectId = `file:${repo.id}:${side}:${entry.oid}:${safePath}`;
		const start = this.offset(cursor, "file", objectId);
		if (start > size) throw new SystemsReviewReaderError("INVALID_CURSOR", "File cursor starts beyond the bound blob.");
		const maxBytes = checkedLimit(limit, SYSTEMS_REVIEW_MAX_CONTENT_BYTES, SYSTEMS_REVIEW_MAX_CONTENT_BYTES);
		const content = await this.blobRange(repo, entry.oid, start, maxBytes, size, started);
		if (content.includes(0)) throw new SystemsReviewReaderError("BINARY_FILE", `Binary blob "${safePath}" is body-exempt and cannot be read.`);
		const end = start + content.byteLength;
		return this.page("file", objectId, start, end, end >= size, { encoding: "utf8", content: content.toString("utf8"), blobOid: entry.oid, totalBytes: size }, { repoId, path: safePath, side });
	}

	private async treeEntries(repo: SystemsReviewRepoBinding, side: SystemsReviewTreeSide, prefix: string | undefined, started: number): Promise<TreeEntry[]> {
		const safePrefix = prefix ? assertSystemsReviewReadablePath(prefix) : undefined;
		const args = ["-c", "core.quotepath=false", "ls-tree", "-r", "-z", treeFor(repo, side), ...(safePrefix ? ["--", literalPathspec(safePrefix)] : [])];
		const entries: TreeEntry[] = [];
		let pending = Buffer.alloc(0);
		await this.git(repo, args, started, chunk => {
			pending = Buffer.concat([pending, chunk]);
			let delimiter = pending.indexOf(0);
			while (delimiter >= 0) {
				const token = pending.subarray(0, delimiter);
				pending = pending.subarray(delimiter + 1);
				if (token.byteLength > 0) entries.push(parseTreeEntry(token));
				delimiter = pending.indexOf(0);
			}
		});
		if (pending.byteLength > 0) throw new SystemsReviewReaderError("MALFORMED_TREE", "Git tree stream ended inside an entry.");
		for (const entry of entries) {
			assertSystemsReviewReadablePath(entry.path);
			if (entry.mode === "120000" || entry.mode === "160000" || entry.type === "commit") throw new SystemsReviewReaderError("UNREADABLE_TREE_ENTRY", `Tree contains an unreadable symlink or submodule path: ${entry.path}`);
		}
		return entries;
	}

	private async readList(repoId: string, side: SystemsReviewTreeSide, prefix: string | undefined, cursor: string | undefined, limit: number | undefined, started: number): Promise<SystemsReviewReadPage> {
		const repo = repoFor(this.snapshot, repoId);
		const safePrefix = prefix ? assertSystemsReviewReadablePath(prefix) : "";
		const objectId = `list:${repo.id}:${side}:${treeFor(repo, side)}:${sha256(safePrefix)}`;
		const entries = await this.treeEntries(repo, side, safePrefix || undefined, started);
		const requested = checkedLimit(limit, SYSTEMS_REVIEW_MAX_PAGE_RECORDS, SYSTEMS_REVIEW_MAX_PAGE_RECORDS);
		const records = entries.map(entry => ({ mode: entry.mode, type: entry.type, blobOid: entry.oid, path: entry.path }));
		const page = this.recordsPage("list", objectId, records, cursor, requested);
		return this.page("list", objectId, page.range.start, page.range.end, page.range.complete, page.data, { repoId, path: safePrefix, side });
	}

	private async readWholeTextBlob(repo: SystemsReviewRepoBinding, entry: TreeEntry, size: number, started: number): Promise<string> {
		const buffer = await this.blobRange(repo, entry.oid, 0, size, size, started);
		if (buffer.includes(0)) throw new SystemsReviewReaderError("BINARY_FILE", `Binary blob "${entry.path}" cannot be searched.`);
		return buffer.toString("utf8");
	}

	private async readSearch(repoId: string, side: SystemsReviewTreeSide, paths: string[], query: string, cursor: string | undefined, limit: number | undefined, started: number): Promise<SystemsReviewReadPage> {
		const repo = repoFor(this.snapshot, repoId);
		if (Buffer.byteLength(query, "utf8") < 1 || Buffer.byteLength(query, "utf8") > SYSTEMS_REVIEW_SEARCH_MAX_QUERY_BYTES) throw new SystemsReviewReaderError("INVALID_QUERY", `Literal search query must contain 1 to ${SYSTEMS_REVIEW_SEARCH_MAX_QUERY_BYTES} UTF-8 bytes.`);
		if (!Array.isArray(paths) || paths.length < 1 || paths.length > SYSTEMS_REVIEW_SEARCH_MAX_PATHS) throw new SystemsReviewReaderError("INVALID_SEARCH_PATHS", `Literal search requires 1 to ${SYSTEMS_REVIEW_SEARCH_MAX_PATHS} paths.`);
		const safePaths = [...new Set(paths.map(candidate => assertSystemsReviewReadablePath(candidate)))];
		const objectId = `search:${repo.id}:${side}:${treeFor(repo, side)}:${sha256(stableJson({ paths: safePaths, query }))}`;
		const records: SearchRecord[] = [];
		let aggregateBytes = 0;
		for (const safePath of safePaths) {
			const entry = await this.exactTreeEntry(repo, side, safePath, started);
			const size = await this.blobSize(repo, entry.oid, started);
			aggregateBytes += size;
			if (aggregateBytes > SYSTEMS_REVIEW_SEARCH_MAX_FILE_BYTES) throw new SystemsReviewReaderError("SEARCH_BUDGET_EXCEEDED", "Literal search file inputs exceed the 10 MiB bound.");
			const content = await this.readWholeTextBlob(repo, entry, size, started);
			const lines = content.split("\n");
			for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
				let from = 0;
				while (from <= lines[lineIndex].length) {
					const column = lines[lineIndex].indexOf(query, from);
					if (column < 0) break;
					records.push({ path: safePath, line: lineIndex + 1, column: column + 1, text: lines[lineIndex].slice(0, 2_000), blobOid: entry.oid });
					from = column + Math.max(1, query.length);
				}
			}
		}
		const page = this.recordsPage("search", objectId, records, cursor, limit);
		return this.page("search", objectId, page.range.start, page.range.end, page.range.complete, page.data, { repoId, side });
	}
}

export function isGapFreeReceiptCoverage(claims: readonly SystemsReviewReceiptClaims[], operation: SystemsReviewReadOperation, objectId: string, expectedEnd: number): boolean {
	const sorted = claims.filter(claim => claim.operation === operation && claim.objectId === objectId).sort((a, b) => a.start - b.start || a.end - b.end);
	let cursor = 0;
	for (const claim of sorted) {
		if (claim.start !== cursor || claim.end < claim.start) return false;
		cursor = claim.end;
	}
	return cursor === expectedEnd && (expectedEnd === 0 || sorted.at(-1)?.complete === true);
}

export function changedPathForSystemsReview(change: SystemsReviewChange): string {
	return change.newPath ?? change.oldPath ?? "";
}

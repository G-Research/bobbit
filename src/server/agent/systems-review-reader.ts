import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
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
export const SYSTEMS_REVIEW_SEARCH_TIMEOUT_MS = 2_000;
export const SYSTEMS_REVIEW_SEARCH_MAX_QUERY_BYTES = 256;
export const SYSTEMS_REVIEW_SEARCH_MAX_PATHS = 50;
export const SYSTEMS_REVIEW_SEARCH_MAX_FILE_BYTES = 10 * 1024 * 1024;

type CursorPosition =
	| { kind: "list"; afterPath: string }
	| { kind: "search"; pathIndex: number; byteOffset: number; line: number; column: number; linePrefix: string };

interface CursorClaims {
	version: typeof SYSTEMS_REVIEW_READER_VERSION;
	kind: "cursor";
	sessionId: string;
	signalId: string;
	snapshotDigest: string;
	operation: SystemsReviewReadOperation;
	objectId: string;
	offset: number;
	position?: CursorPosition;
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

interface PendingSearchRecord extends Omit<SearchRecord, "text"> {
	position: Extract<CursorPosition, { kind: "search" }>;
}

function compareGitPaths(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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

	private cursorClaims(cursor: string | undefined, operation: SystemsReviewReadOperation, objectId: string): CursorClaims {
		if (!cursor) {
			return {
				version: SYSTEMS_REVIEW_READER_VERSION,
				kind: "cursor",
				sessionId: this.snapshot.sessionId,
				signalId: this.snapshot.signalId,
				snapshotDigest: this.snapshot.digest,
				operation,
				objectId,
				offset: 0,
			};
		}
		const claims = decodeSigned<CursorClaims>(cursor, "sr-c1", this.secret);
		if (claims?.version !== SYSTEMS_REVIEW_READER_VERSION || claims.kind !== "cursor" || claims.sessionId !== this.snapshot.sessionId || claims.signalId !== this.snapshot.signalId || claims.snapshotDigest !== this.snapshot.digest || claims.operation !== operation || claims.objectId !== objectId || !Number.isSafeInteger(claims.offset) || claims.offset < 0) {
			throw new SystemsReviewReaderError("CURSOR_SCOPE_MISMATCH", "Systems review cursor does not match this session, signal, snapshot, operation, or object.");
		}
		return claims;
	}

	private offset(cursor: string | undefined, operation: SystemsReviewReadOperation, objectId: string): number {
		return this.cursorClaims(cursor, operation, objectId).offset;
	}

	private cursor(operation: SystemsReviewReadOperation, objectId: string, offset: number, position?: CursorPosition): string {
		return encodeSigned("sr-c1", {
			version: SYSTEMS_REVIEW_READER_VERSION,
			kind: "cursor",
			sessionId: this.snapshot.sessionId,
			signalId: this.snapshot.signalId,
			snapshotDigest: this.snapshot.digest,
			operation,
			objectId,
			offset,
			...(position ? { position } : {}),
		} satisfies CursorClaims, this.secret);
	}

	private page<T>(operation: SystemsReviewReadOperation, objectId: string, start: number, end: number, complete: boolean, data: T, binding: Partial<Pick<SystemsReviewReceiptClaims, "repoId" | "path" | "side">> = {}, nextPosition?: CursorPosition): SystemsReviewReadPage<T> {
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
			...(complete ? {} : { nextCursor: this.cursor(operation, objectId, end, nextPosition) }),
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

	private remainingTimeout(started: number, budget = SYSTEMS_REVIEW_READ_TIMEOUT_MS): number {
		const remaining = budget - (Date.now() - started);
		if (remaining <= 0) throw new SystemsReviewReaderError("READ_TIMEOUT", `Systems review read exceeded ${budget}ms.`);
		return remaining;
	}

	private async git(repo: SystemsReviewRepoBinding, args: readonly string[], started: number, onStdout?: (chunk: Buffer) => void, budget = SYSTEMS_REVIEW_READ_TIMEOUT_MS): Promise<Buffer> {
		return runSystemsReviewGit(repo.root, args, this.commandRunner, onStdout, this.remainingTimeout(started, budget));
	}

	private async streamGit(repo: SystemsReviewRepoBinding, args: readonly string[], started: number, onStdout: (chunk: Buffer) => boolean, budget = SYSTEMS_REVIEW_READ_TIMEOUT_MS): Promise<boolean> {
		if (this.commandRunner && !this.commandRunner.spawn) {
			throw new SystemsReviewReaderError("STREAMING_UNAVAILABLE", "Bounded Systems review list/search requires a streaming command runner.");
		}
		const timeout = this.remainingTimeout(started, budget);
		return new Promise<boolean>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = this.commandRunner?.spawn
					? this.commandRunner.spawn("git", args, { cwd: repo.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
					: nodeSpawn("git", [...args], { cwd: repo.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			} catch (error) {
				reject(error);
				return;
			}
			let stopped = false;
			let timedOut = false;
			let callbackError: unknown;
			let stderr = Buffer.alloc(0);
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeout);
			child.stdout?.on("data", (value: Buffer | string) => {
				if (stopped || callbackError) return;
				try {
					if (onStdout(Buffer.isBuffer(value) ? value : Buffer.from(value))) {
						stopped = true;
						child.kill("SIGKILL");
					}
				} catch (error) {
					callbackError = error;
					child.kill("SIGKILL");
				}
			});
			child.stderr?.on("data", (value: Buffer | string) => {
				if (stderr.byteLength >= SYSTEMS_REVIEW_MAX_CONTENT_BYTES) return;
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
				stderr = Buffer.concat([stderr, chunk.subarray(0, SYSTEMS_REVIEW_MAX_CONTENT_BYTES - stderr.byteLength)]);
			});
			child.once("error", error => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", code => {
				clearTimeout(timer);
				if (callbackError) {
					reject(callbackError);
					return;
				}
				if (stopped) {
					resolve(true);
					return;
				}
				if (timedOut || Date.now() - started >= budget) {
					reject(new SystemsReviewReaderError("READ_TIMEOUT", `Systems review read exceeded ${budget}ms.`));
					return;
				}
				if (code !== 0) {
					reject(new SystemsReviewReaderError("GIT_FAILED", `git ${args.join(" ")} failed: ${stderr.toString("utf8").trim()}`));
					return;
				}
				resolve(false);
			});
		});
	}

	private async exactTreeEntry(repo: SystemsReviewRepoBinding, side: SystemsReviewTreeSide, candidatePath: string, started: number, budget = SYSTEMS_REVIEW_READ_TIMEOUT_MS): Promise<TreeEntry> {
		const safePath = assertSystemsReviewReadablePath(candidatePath);
		if (isSystemsReviewBodyExemptPath(safePath)) throw new SystemsReviewReaderError("BODY_EXEMPT_PATH", `Body-exempt asset or dependency lockfile "${safePath}" cannot be read or searched.`);
		const raw = await this.git(repo, ["-c", "core.quotepath=false", "ls-tree", "-z", treeFor(repo, side), "--", literalPathspec(safePath)], started, undefined, budget);
		const tokens = raw.subarray(0, raw.at(-1) === 0 ? raw.length - 1 : raw.length).toString("binary");
		if (!tokens) throw new SystemsReviewReaderError("PATH_NOT_FOUND", `Path "${safePath}" does not exist in the bound ${side} tree.`);
		const entries = raw.toString("binary").split("\0").filter(Boolean).map(token => parseTreeEntry(Buffer.from(token, "binary")));
		const entry = entries.find(item => item.path === safePath);
		if (!entry) throw new SystemsReviewReaderError("PATH_NOT_FOUND", `Path "${safePath}" does not resolve to an exact bound-tree entry.`);
		assertReadableTreeEntry(entry);
		return entry;
	}

	private async blobSize(repo: SystemsReviewRepoBinding, oid: string, started: number, budget = SYSTEMS_REVIEW_READ_TIMEOUT_MS): Promise<number> {
		const raw = (await this.git(repo, ["cat-file", "-s", oid], started, undefined, budget)).toString("utf8").trim();
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

	private async readList(repoId: string, side: SystemsReviewTreeSide, prefix: string | undefined, cursor: string | undefined, limit: number | undefined, started: number): Promise<SystemsReviewReadPage> {
		const repo = repoFor(this.snapshot, repoId);
		const safePrefix = prefix ? assertSystemsReviewReadablePath(prefix) : "";
		const objectId = `list:${repo.id}:${side}:${treeFor(repo, side)}:${sha256(safePrefix)}`;
		const claims = this.cursorClaims(cursor, "list", objectId);
		const position = claims.position;
		if (cursor && (position?.kind !== "list" || !position.afterPath)) throw new SystemsReviewReaderError("INVALID_CURSOR", "List cursor omitted its exact tree position.");
		const afterPath = position?.kind === "list" ? position.afterPath : undefined;
		const requested = checkedLimit(limit, SYSTEMS_REVIEW_MAX_PAGE_RECORDS, SYSTEMS_REVIEW_MAX_PAGE_RECORDS);
		const records: Array<{ mode: string; type: TreeEntry["type"]; blobOid: string; path: string }> = [];
		let recordsBytes = 2;
		let pending = Buffer.alloc(0);
		let previousPath: string | undefined;
		let resumeSeen = afterPath === undefined;
		let overflow = false;
		let lastReturnedPath: string | undefined;
		const args = ["-c", "core.quotepath=false", "ls-tree", "-r", "-z", treeFor(repo, side), ...(safePrefix ? ["--", literalPathspec(safePrefix)] : [])];
		const stopped = await this.streamGit(repo, args, started, chunk => {
			pending = Buffer.concat([pending, chunk]);
			let delimiter = pending.indexOf(0);
			while (delimiter >= 0) {
				const token = pending.subarray(0, delimiter);
				pending = pending.subarray(delimiter + 1);
				delimiter = pending.indexOf(0);
				if (token.byteLength === 0) continue;
				const entry = parseTreeEntry(token);
				assertReadableTreeEntry(entry);
				if (previousPath !== undefined && compareGitPaths(previousPath, entry.path) >= 0) throw new SystemsReviewReaderError("MALFORMED_TREE", "Git tree traversal was not strictly ordered.");
				previousPath = entry.path;
				if (!resumeSeen) {
					const comparison = compareGitPaths(entry.path, afterPath!);
					if (comparison < 0) continue;
					if (comparison > 0) throw new SystemsReviewReaderError("INVALID_CURSOR", "List cursor tree position no longer exists.");
					resumeSeen = true;
					continue;
				}
				const record = { mode: entry.mode, type: entry.type, blobOid: entry.oid, path: entry.path };
				const nextRecordBytes = Buffer.byteLength(stableJson(record), "utf8") + (records.length === 0 ? 0 : 1);
				if (records.length >= requested || recordsBytes + nextRecordBytes > SYSTEMS_REVIEW_MAX_CONTENT_BYTES) {
					if (records.length === 0) throw new SystemsReviewReaderError("OVERSIZED_RECORD", "A Systems review tree record exceeds the bounded page size.");
					overflow = true;
					return true;
				}
				records.push(record);
				recordsBytes += nextRecordBytes;
				lastReturnedPath = entry.path;
			}
			if (pending.byteLength > SYSTEMS_REVIEW_MAX_CONTENT_BYTES) throw new SystemsReviewReaderError("OVERSIZED_RECORD", "A Systems review tree record exceeds the bounded page size.");
			return false;
		});
		if (!stopped && pending.byteLength > 0) throw new SystemsReviewReaderError("MALFORMED_TREE", "Git tree stream ended inside an entry.");
		if (!resumeSeen) throw new SystemsReviewReaderError("INVALID_CURSOR", "List cursor tree position no longer exists.");
		const complete = !stopped && !overflow;
		const end = claims.offset + records.length;
		if (!complete && !lastReturnedPath) throw new SystemsReviewReaderError("INVALID_CURSOR", "List traversal made no resumable progress.");
		return this.page("list", objectId, claims.offset, end, complete, records, { repoId, path: safePrefix, side }, complete ? undefined : { kind: "list", afterPath: lastReturnedPath! });
	}

	private async readSearch(repoId: string, side: SystemsReviewTreeSide, paths: string[], query: string, cursor: string | undefined, limit: number | undefined, started: number): Promise<SystemsReviewReadPage> {
		const repo = repoFor(this.snapshot, repoId);
		const queryBytes = Buffer.from(query, "utf8");
		if (queryBytes.byteLength < 1 || queryBytes.byteLength > SYSTEMS_REVIEW_SEARCH_MAX_QUERY_BYTES) throw new SystemsReviewReaderError("INVALID_QUERY", `Literal search query must contain 1 to ${SYSTEMS_REVIEW_SEARCH_MAX_QUERY_BYTES} UTF-8 bytes.`);
		if (!Array.isArray(paths) || paths.length < 1 || paths.length > SYSTEMS_REVIEW_SEARCH_MAX_PATHS) throw new SystemsReviewReaderError("INVALID_SEARCH_PATHS", `Literal search requires 1 to ${SYSTEMS_REVIEW_SEARCH_MAX_PATHS} paths.`);
		const safePaths = [...new Set(paths.map(candidate => assertSystemsReviewReadablePath(candidate)))];
		const objectId = `search:${repo.id}:${side}:${treeFor(repo, side)}:${sha256(stableJson({ paths: safePaths, query }))}`;
		const claims = this.cursorClaims(cursor, "search", objectId);
		const requested = checkedLimit(limit, SYSTEMS_REVIEW_MAX_PAGE_RECORDS, SYSTEMS_REVIEW_MAX_PAGE_RECORDS);
		const entries: Array<{ entry: TreeEntry; size: number }> = [];
		let aggregateBytes = 0;
		for (const safePath of safePaths) {
			const entry = await this.exactTreeEntry(repo, side, safePath, started, SYSTEMS_REVIEW_SEARCH_TIMEOUT_MS);
			const size = await this.blobSize(repo, entry.oid, started, SYSTEMS_REVIEW_SEARCH_TIMEOUT_MS);
			aggregateBytes += size;
			if (aggregateBytes > SYSTEMS_REVIEW_SEARCH_MAX_FILE_BYTES) throw new SystemsReviewReaderError("SEARCH_BUDGET_EXCEEDED", "Literal search file inputs exceed the 10 MiB bound.");
			entries.push({ entry, size });
		}

		const initialPosition: Extract<CursorPosition, { kind: "search" }> = { kind: "search", pathIndex: 0, byteOffset: 0, line: 1, column: 1, linePrefix: "" };
		const resume = claims.position ?? initialPosition;
		if (cursor && resume.kind !== "search") throw new SystemsReviewReaderError("INVALID_CURSOR", "Search cursor omitted its exact match position.");
		if (resume.kind !== "search" || !Number.isSafeInteger(resume.pathIndex) || resume.pathIndex < 0 || resume.pathIndex >= entries.length || !Number.isSafeInteger(resume.byteOffset) || resume.byteOffset < 0 || resume.byteOffset > entries[resume.pathIndex].size || !Number.isSafeInteger(resume.line) || resume.line < 1 || !Number.isSafeInteger(resume.column) || resume.column < 1 || typeof resume.linePrefix !== "string" || resume.linePrefix.length > 2_000) {
			throw new SystemsReviewReaderError("INVALID_CURSOR", "Search cursor position is malformed or beyond the bound blob.");
		}

		const records: SearchRecord[] = [];
		let recordsBytes = 2;
		let lastPosition: Extract<CursorPosition, { kind: "search" }> | undefined;
		let overflow = false;
		const queryHasNewline = queryBytes.includes(0x0a);

		for (let pathIndex = resume.pathIndex; pathIndex < entries.length && !overflow; pathIndex++) {
			const { entry, size } = entries[pathIndex];
			const pathResume = pathIndex === resume.pathIndex ? resume : { ...initialPosition, pathIndex };
			let absoluteOffset = pathResume.byteOffset;
			let physicalOffset = 0;
			let line = pathResume.line;
			let column = pathResume.column;
			let linePrefix = pathResume.linePrefix;
			let prefixComplete = linePrefix.length >= 2_000;
			let decoder = new StringDecoder("utf8");
			let buffered = Buffer.alloc(0);
			let pendingLine: PendingSearchRecord[] = [];

			const flushLine = (): boolean => {
				for (const pendingRecord of pendingLine) {
					const record: SearchRecord = { path: pendingRecord.path, line: pendingRecord.line, column: pendingRecord.column, text: linePrefix, blobOid: pendingRecord.blobOid };
					const nextRecordBytes = Buffer.byteLength(stableJson(record), "utf8") + (records.length === 0 ? 0 : 1);
					if (records.length >= requested || recordsBytes + nextRecordBytes > SYSTEMS_REVIEW_MAX_CONTENT_BYTES) {
						if (records.length === 0) throw new SystemsReviewReaderError("OVERSIZED_RECORD", "A Systems review search record exceeds the bounded page size.");
						overflow = true;
						break;
					}
					records.push(record);
					recordsBytes += nextRecordBytes;
					lastPosition = pendingRecord.position;
				}
				pendingLine = [];
				return overflow;
			};

			const appendDecoded = (text: string): boolean => {
				column += text.length;
				if (!prefixComplete) {
					linePrefix = (linePrefix + text).slice(0, 2_000);
					prefixComplete = linePrefix.length >= 2_000;
					if (prefixComplete && flushLine()) return true;
				}
				return false;
			};

			const consumeText = (value: Buffer): boolean => {
				absoluteOffset += value.byteLength;
				return appendDecoded(decoder.write(value));
			};

			const consumeBuffer = (final: boolean): boolean => {
				while (buffered.byteLength > 0) {
					const newline = buffered.indexOf(0x0a);
					const match = queryHasNewline ? -1 : buffered.indexOf(queryBytes);
					const event = newline < 0 ? match : match < 0 ? newline : Math.min(newline, match);
					const safeBytes = final ? buffered.byteLength : Math.max(0, buffered.byteLength - Math.max(0, queryBytes.byteLength - 1));
					if (event < 0 || event >= safeBytes) {
						if (safeBytes === 0) return false;
						const value = buffered.subarray(0, safeBytes);
						buffered = buffered.subarray(safeBytes);
						if (consumeText(value)) return true;
						continue;
					}
					if (event > 0) {
						const value = buffered.subarray(0, event);
						buffered = buffered.subarray(event);
						if (consumeText(value)) return true;
					}
					if (buffered[0] === 0x0a) {
						buffered = buffered.subarray(1);
						absoluteOffset++;
						const decodedNewline = decoder.write(Buffer.from([0x0a]));
						if (decodedNewline.length > 1 && appendDecoded(decodedNewline.slice(0, -1))) return true;
						if (flushLine()) return true;
						line++;
						column = 1;
						linePrefix = "";
						prefixComplete = false;
						decoder = new StringDecoder("utf8");
						continue;
					}
					const recordLine = line;
					const recordColumn = column;
					buffered = buffered.subarray(queryBytes.byteLength);
					if (consumeText(queryBytes)) return true;
					if (pendingLine.length <= requested - records.length) {
						pendingLine.push({
							path: entry.path,
							line: recordLine,
							column: recordColumn,
							blobOid: entry.oid,
							position: { kind: "search", pathIndex, byteOffset: absoluteOffset, line, column, linePrefix },
						});
					}
					if (prefixComplete && flushLine()) return true;
				}
				return false;
			};

			const stopped = await this.streamGit(repo, ["cat-file", "blob", entry.oid], started, chunk => {
				const chunkEnd = physicalOffset + chunk.byteLength;
				const skip = Math.max(0, pathResume.byteOffset - physicalOffset);
				physicalOffset = chunkEnd;
				if (skip >= chunk.byteLength) return false;
				const readable = chunk.subarray(skip);
				if (readable.includes(0)) throw new SystemsReviewReaderError("BINARY_FILE", `Binary blob "${entry.path}" cannot be searched.`);
				buffered = Buffer.concat([buffered, readable]);
				return consumeBuffer(false);
			}, SYSTEMS_REVIEW_SEARCH_TIMEOUT_MS);
			if (stopped) break;
			if (physicalOffset !== size) throw new SystemsReviewReaderError("STALE_BLOB", `Bound blob ${entry.oid} changed size while being searched.`);
			if (consumeBuffer(true)) break;
			const tail = decoder.end();
			if (tail && appendDecoded(tail)) break;
			if (flushLine()) break;
		}

		const end = claims.offset + records.length;
		const complete = !overflow;
		if (!complete && !lastPosition) throw new SystemsReviewReaderError("INVALID_CURSOR", "Search traversal made no resumable progress.");
		return this.page("search", objectId, claims.offset, end, complete, records, { repoId, side }, complete ? undefined : lastPosition);
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

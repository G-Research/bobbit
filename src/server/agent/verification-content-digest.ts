import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { hashingStream } from "hasha";
import { realCommandRunner, type CommandRunner } from "../gateway-deps.js";

export interface VerificationContentDigest {
	algorithm: "sha256";
	version: 1;
	digest: string;
	fileCount: number;
}

export class VerificationContentDigestError extends Error {
	readonly code = "VERIFICATION_CONTENT_DIGEST_FAILED" as const;

	constructor(message = "Unable to compute verification content digest") {
		super(message);
		this.name = "VerificationContentDigestError";
	}
}

export interface VerificationContentDigestErrorSummary {
	code: "VERIFICATION_CONTENT_DIGEST_FAILED";
	message: string;
}

const HEADER = "bobbit/gate-content-digest/v1\0";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type VerificationSourceInventoryMembership = "tracked" | "untracked";

/**
 * Strictly decoded Git source inventory shared by the digest witness and
 * pinned-checkout materializer. `rawPath` keeps Git's byte ordering intact.
 */
export interface VerificationSourceInventoryEntry {
	relativePath: string;
	rawPath: Buffer;
	membership: VerificationSourceInventoryMembership;
}

/** Keep failure diagnostics durable and useful without leaking paths or stacks. */
export function summarizeVerificationContentDigestError(error: unknown): VerificationContentDigestErrorSummary {
	return {
		code: "VERIFICATION_CONTENT_DIGEST_FAILED",
		message: error instanceof VerificationContentDigestError
			? error.message
			: "Unable to compute verification content digest",
	};
}

function digestFailure(message?: string): VerificationContentDigestError {
	return new VerificationContentDigestError(message);
}

/**
 * Git emits filename bytes with -z. Decode only valid UTF-8: replacement
 * decoding can alias an invalid byte sequence with a literal U+FFFD filename.
 */
function nulPaths(stdout: string | Buffer): Array<Pick<VerificationSourceInventoryEntry, "relativePath" | "rawPath">> {
	if (!Buffer.isBuffer(stdout)) throw digestFailure();
	const entries: Array<Pick<VerificationSourceInventoryEntry, "relativePath" | "rawPath">> = [];
	let start = 0;
	for (let index = 0; index <= stdout.length; index++) {
		if (index !== stdout.length && stdout[index] !== 0) continue;
		if (index > start) {
			const rawPath = stdout.subarray(start, index);
			let relativePath: string;
			try { relativePath = utf8.decode(rawPath); }
			catch { throw digestFailure(); }
			entries.push({ relativePath: normalizeInventoryPath(relativePath), rawPath: Buffer.from(rawPath) });
		}
		start = index + 1;
	}
	return entries;
}

function normalizeInventoryPath(candidate: string): string {
	if (!candidate || candidate.includes("\0") || (process.platform === "win32" && candidate.includes("\\")) || path.posix.isAbsolute(candidate)) throw digestFailure();
	const normalized = path.posix.normalize(candidate);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) throw digestFailure();
	return normalized;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Identity comparisons must use full-width stat values; Windows file IDs can exceed 2^53. */
export function sameVerificationFileIdentity(
	left: Pick<BigIntStats, "dev" | "ino">,
	right: Pick<BigIntStats, "dev" | "ino">,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** Reject every symlink or non-directory component below the canonical root. */
async function validateDirectoryAncestors(root: string, absolutePath: string): Promise<void> {
	if (!isWithin(root, absolutePath)) throw digestFailure();
	const rootStats = await lstat(root);
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw digestFailure();
	const relative = path.relative(root, absolutePath);
	const segments = relative.split(path.sep).slice(0, -1);
	let ancestor = root;
	for (const segment of segments) {
		ancestor = path.join(ancestor, segment);
		const stats = await lstat(ancestor);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw digestFailure();
	}
}

function record(aggregate: ReturnType<typeof createHash>, kind: string, mode: string, relativePath: string, fileHash: string): void {
	aggregate.update(kind);
	aggregate.update("\0");
	aggregate.update(mode);
	aggregate.update("\0");
	aggregate.update(relativePath);
	aggregate.update("\0");
	aggregate.update(fileHash);
	aggregate.update("\0");
}

async function hashOpenedFile(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
	const output: Buffer[] = [];
	await pipeline(
		handle.createReadStream({ autoClose: false }),
		// hasha supports buffer output at runtime, but its hashingStream declaration
		// incorrectly fixes Options to the default hex encoding.
		hashingStream({ algorithm: "sha256", encoding: "buffer" } as never),
		new Writable({
			write(chunk, _encoding, callback) {
				output.push(Buffer.from(chunk));
				callback();
			},
		}),
	);
	return Buffer.concat(output).toString("hex");
}

/**
 * Hash a leaf using one descriptor. The final-component no-follow open, fstat,
 * pathname identity check, and descriptor-backed stream bind kind/mode/bytes
 * to the object witnessed after the parent-directory validation.
 */
async function hashRegularFile(root: string, absolutePath: string): Promise<{ digest: string; executable: boolean }> {
	await validateDirectoryAncestors(root, absolutePath);
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const flags = constants.O_RDONLY
		| noFollow
		| (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
	const handle = await open(absolutePath, flags);
	try {
		const openedStats = await handle.stat({ bigint: true });
		if (!openedStats.isFile() || openedStats.isSymbolicLink()) throw digestFailure();

		// Repeat validation after open, then tie the pathname to the descriptor.
		await validateDirectoryAncestors(root, absolutePath);
		const pathnameStats = await lstat(absolutePath, { bigint: true });
		if (!pathnameStats.isFile() || pathnameStats.isSymbolicLink() || !sameVerificationFileIdentity(openedStats, pathnameStats)) throw digestFailure();

		return {
			digest: await hashOpenedFile(handle),
			executable: (openedStats.mode & 0o111n) !== 0n,
		};
	} finally {
		await handle.close();
	}
}

async function hashSymlink(root: string, absolutePath: string): Promise<string> {
	await validateDirectoryAncestors(root, absolutePath);
	const target = await readlink(absolutePath, { encoding: "buffer" }) as Buffer;
	let targetText: string;
	try { targetText = utf8.decode(target); }
	catch { throw digestFailure(); }
	const resolvedTarget = path.resolve(path.dirname(absolutePath), targetText);
	if (!isWithin(root, resolvedTarget)) throw digestFailure();
	// Verify that an in-root target does not traverse a symlinked ancestor either.
	await validateDirectoryAncestors(root, resolvedTarget);
	try {
		// A target may be dangling, but an existing final symlink could resolve out.
		if ((await lstat(resolvedTarget)).isSymbolicLink()) throw digestFailure();
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
	return createHash("sha256").update(target).digest("hex");
}

/**
 * Read exactly the Git inventory that defines a verification source witness.
 * This intentionally does not inspect the filesystem: callers materializing
 * the inventory must still bind each path to safe filesystem objects.
 */
export async function readVerificationSourceInventory(
	worktreeRoot: string,
	commandRunner: CommandRunner = realCommandRunner,
): Promise<VerificationSourceInventoryEntry[]> {
	try {
		const [trackedResult, untrackedResult] = await Promise.all([
			commandRunner.execFile("git", ["-C", worktreeRoot, "ls-files", "--cached", "-z"], { encoding: "buffer", timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }),
			commandRunner.execFile("git", ["-C", worktreeRoot, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer", timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }),
		]);
		const tracked = nulPaths(trackedResult.stdout);
		const inventory = new Map<string, VerificationSourceInventoryEntry>();
		for (const entry of tracked) inventory.set(entry.relativePath, { ...entry, membership: "tracked" });
		for (const entry of nulPaths(untrackedResult.stdout)) {
			if (!inventory.has(entry.relativePath)) inventory.set(entry.relativePath, { ...entry, membership: "untracked" });
		}
		return [...inventory.values()].sort((left, right) => Buffer.compare(left.rawPath, right.rawPath));
	} catch (error) {
		if (error instanceof VerificationContentDigestError) throw error;
		throw digestFailure();
	}
}

/**
 * Fingerprint the live bytes verification commands can read in one goal's branch
 * container. Git owns inventory/ignore behavior; hasha owns streamed file reads.
 */
/**
 * Hash a known inventory against a root without consulting Git. Pinned
 * checkouts use this to avoid their detached `--no-checkout` worktree index:
 * that index is intentionally empty on real Git, so re-reading it cannot
 * attest to the source inventory that was actually materialized.
 */
export async function computeVerificationContentDigestFromInventory(
	worktreeRoot: string,
	inventory: readonly VerificationSourceInventoryEntry[],
): Promise<VerificationContentDigest> {
	try {
		const root = await realpath(worktreeRoot);
		const aggregate = createHash("sha256");
		aggregate.update(HEADER);
		for (const entry of inventory) {
			const absolutePath = path.resolve(root, entry.relativePath);
			if (!isWithin(root, absolutePath)) throw digestFailure();
			let info: Stats;
			try {
				await validateDirectoryAncestors(root, absolutePath);
				info = await lstat(absolutePath);
			} catch (error: any) {
				if (error?.code === "ENOENT" && entry.membership === "tracked") {
					record(aggregate, "deleted", "-", entry.relativePath, "-");
					continue;
				}
				throw digestFailure();
			}
			if (info.isFile()) {
				const { digest, executable } = await hashRegularFile(root, absolutePath);
				record(aggregate, "file", executable ? "executable" : "regular", entry.relativePath, digest);
				continue;
			}
			if (info.isSymbolicLink()) {
				record(aggregate, "symlink", "symlink", entry.relativePath, await hashSymlink(root, absolutePath));
				continue;
			}
			// Directories include gitlink/submodule entries; neither is a safe byte witness.
			throw digestFailure();
		}
		return { algorithm: "sha256", version: 1, digest: aggregate.digest("hex"), fileCount: inventory.length };
	} catch (error) {
		if (error instanceof VerificationContentDigestError) throw error;
		throw digestFailure();
	}
}

/**
 * Combine independently-read repository inventories without changing the v1
 * record encoding. Prefixing preserves the logical branch-container layout and
 * prevents equal names in separate repositories from aliasing.
 */
export function prefixVerificationSourceInventory(
	repositories: readonly { repoKey: string; inventory: readonly VerificationSourceInventoryEntry[] }[],
): VerificationSourceInventoryEntry[] {
	const output: VerificationSourceInventoryEntry[] = [];
	const seen = new Set<string>();
	for (const repository of repositories) {
		const key = repository.repoKey === "." ? "." : normalizeInventoryPath(repository.repoKey);
		for (const entry of repository.inventory) {
			const relativePath = key === "." ? entry.relativePath : `${key}/${entry.relativePath}`;
			if (seen.has(relativePath)) throw digestFailure();
			seen.add(relativePath);
			output.push({ ...entry, relativePath, rawPath: Buffer.from(relativePath, "utf8") });
		}
	}
	return output.sort((left, right) => Buffer.compare(left.rawPath, right.rawPath));
}

export async function computeVerificationContentDigest(
	worktreeRoot: string,
	commandRunner: CommandRunner = realCommandRunner,
): Promise<VerificationContentDigest> {
	try {
		const inventory = await readVerificationSourceInventory(worktreeRoot, commandRunner);
		return await computeVerificationContentDigestFromInventory(worktreeRoot, inventory);
	} catch (error) {
		if (error instanceof VerificationContentDigestError) throw error;
		throw digestFailure();
	}
}

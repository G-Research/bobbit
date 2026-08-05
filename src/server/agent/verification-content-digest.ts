import { createHash } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "hasha";
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

function nulPaths(stdout: string | Buffer): string[] {
	const values = Buffer.isBuffer(stdout)
		? stdout.toString("utf8").split("\0")
		: stdout.split("\0");
	return values.filter(Boolean).map(normalizeInventoryPath);
}

function normalizeInventoryPath(candidate: string): string {
	if (!candidate || candidate.includes("\0") || candidate.includes("\\") || path.posix.isAbsolute(candidate)) throw digestFailure();
	const normalized = path.posix.normalize(candidate);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) throw digestFailure();
	return normalized;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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

/**
 * Fingerprint the live bytes verification commands can read in one goal's branch
 * container. Git owns inventory/ignore behavior; hasha owns streamed file reads.
 */
export async function computeVerificationContentDigest(
	worktreeRoot: string,
	commandRunner: CommandRunner = realCommandRunner,
): Promise<VerificationContentDigest> {
	try {
		const [trackedResult, untrackedResult] = await Promise.all([
			commandRunner.execFile("git", ["-C", worktreeRoot, "ls-files", "--cached", "-z"], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }),
			commandRunner.execFile("git", ["-C", worktreeRoot, "ls-files", "--others", "--exclude-standard", "-z"], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }),
		]);
		const tracked = new Set(nulPaths(trackedResult.stdout));
		const inventory = new Map<string, "tracked" | "untracked">();
		for (const entry of tracked) inventory.set(entry, "tracked");
		for (const entry of nulPaths(untrackedResult.stdout)) if (!tracked.has(entry)) inventory.set(entry, "untracked");

		const root = await realpath(worktreeRoot);
		const aggregate = createHash("sha256");
		aggregate.update(HEADER);
		const entries = [...inventory.entries()].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
		for (const [relativePath, membership] of entries) {
			const absolutePath = path.resolve(root, relativePath);
			if (!isWithin(root, absolutePath)) throw digestFailure();
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(absolutePath);
			} catch (error: any) {
				if (error?.code === "ENOENT" && membership === "tracked") {
					record(aggregate, "deleted", "-", relativePath, "-");
					continue;
				}
				throw digestFailure();
			}
			if (info.isFile()) {
				const fileHash = await hashFile(absolutePath, { algorithm: "sha256" });
				record(aggregate, "file", (info.mode & 0o111) !== 0 ? "executable" : "regular", relativePath, fileHash);
				continue;
			}
			if (info.isSymbolicLink()) {
				const resolvedTarget = await realpath(absolutePath).catch(() => { throw digestFailure(); });
				if (!isWithin(root, resolvedTarget)) throw digestFailure();
				const target = await readlink(absolutePath).catch(() => { throw digestFailure(); });
				record(aggregate, "symlink", "symlink", relativePath, createHash("sha256").update(target).digest("hex"));
				continue;
			}
			// Directories include gitlink/submodule entries; neither is a safe byte witness.
			throw digestFailure();
		}
		return { algorithm: "sha256", version: 1, digest: aggregate.digest("hex"), fileCount: entries.length };
	} catch (error) {
		if (error instanceof VerificationContentDigestError) throw error;
		throw digestFailure();
	}
}

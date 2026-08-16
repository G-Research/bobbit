import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	computeVerificationContentDigest,
	sameVerificationFileIdentity,
	VerificationContentDigestError,
} from "../../src/server/agent/verification-content-digest.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "bobbit-content-digest-"));
	roots.push(root);
	await writeFile(path.join(root, ".gitignore"), "ignored/\n");
	await writeFile(path.join(root, ".gitattributes"), "text.txt text\n");
	await writeFile(path.join(root, "text.txt"), "line\n");
	await writeFile(path.join(root, "source.txt"), "source\n");
	return root;
}

function inventory(tracked: Array<string | Buffer>, untracked: Array<string | Buffer> = []) {
	const encode = (entries: Array<string | Buffer>) => Buffer.concat(entries.flatMap(entry => [Buffer.isBuffer(entry) ? entry : Buffer.from(entry), Buffer.from("\0")]));
	return {
		execFile: async (_file: string, args: readonly string[], options?: { encoding?: string }) => {
			assert.equal(options?.encoding, "buffer", "Git inventory must preserve raw filename bytes");
			return {
				stdout: encode(args.includes("--cached") ? tracked : untracked),
				stderr: Buffer.alloc(0),
			};
		},
	};
}

const TRACKED = [".gitignore", ".gitattributes", "text.txt", "source.txt"];
const failedDigest = (error: unknown) => error instanceof VerificationContentDigestError && error.code === "VERIFICATION_CONTENT_DIGEST_FAILED";

describe("computeVerificationContentDigest", () => {
	it("compares full-width filesystem identities without Number precision loss", () => {
		const wide = 2n ** 53n;
		assert.equal(
			sameVerificationFileIdentity({ dev: wide + 10n, ino: wide + 1n }, { dev: wide + 10n, ino: wide + 1n }),
			true,
			"equal identities above Number.MAX_SAFE_INTEGER must remain valid",
		);
		assert.equal(Number(wide), Number(wide + 1n), "the regression values must alias when coerced to Number");
		assert.equal(
			sameVerificationFileIdentity({ dev: wide + 10n, ino: wide }, { dev: wide + 10n, ino: wide + 1n }),
			false,
			"distinct wide file IDs must still detect pathname replacement",
		);
		assert.equal(
			sameVerificationFileIdentity({ dev: wide, ino: wide + 20n }, { dev: wide + 1n, ino: wide + 20n }),
			false,
			"distinct wide device IDs must still detect pathname replacement",
		);
	});

	it("witnesses raw source bytes, additions, modes, and excludes ignored files", async () => {
		const root = await fixture();
		const initial = await computeVerificationContentDigest(root, inventory(TRACKED));
		assert.equal(initial.algorithm, "sha256");
		assert.equal(initial.version, 1);

		await mkdir(path.join(root, "ignored"));
		await writeFile(path.join(root, "ignored", "cache.txt"), "ignored");
		assert.equal((await computeVerificationContentDigest(root, inventory(TRACKED))).digest, initial.digest, "ignored bytes do not enter Git inventory");

		await writeFile(path.join(root, "text.txt"), "line\r\n");
		assert.notEqual((await computeVerificationContentDigest(root, inventory(TRACKED))).digest, initial.digest, "raw CRLF bytes differ despite text attributes");
		await writeFile(path.join(root, "text.txt"), "line\n");
		await writeFile(path.join(root, "new.txt"), "untracked source\n");
		assert.notEqual((await computeVerificationContentDigest(root, inventory(TRACKED, ["new.txt"]))).digest, initial.digest, "untracked source enters inventory");
		await unlink(path.join(root, "new.txt"));
		// Windows does not expose Unix executable bits through chmod/lstat, so it
		// cannot supply a distinct mode witness. Unix platforms still pin it.
		if (process.platform !== "win32") {
			await chmod(path.join(root, "source.txt"), 0o755);
			assert.notEqual((await computeVerificationContentDigest(root, inventory(TRACKED))).digest, initial.digest, "executable mode enters aggregate");
		}
	});

	it("uses hasha's raw SHA-256 bytes in the aggregate", async () => {
		const root = await fixture();
		const result = await computeVerificationContentDigest(root, inventory(["source.txt"]));
		const fileHash = createHash("sha256").update("source\n").digest("hex");
		const expected = createHash("sha256")
			.update("bobbit/gate-content-digest/v1\0")
			.update(`file\0regular\0source.txt\0${fileHash}\0`)
			.digest("hex");
		assert.equal(result.digest, expected, "the aggregate must contain SHA-256 bytes encoded once as hex");
	});

	it("represents tracked deletion and fails closed for unsafe inventory", async () => {
		const root = await fixture();
		const initial = await computeVerificationContentDigest(root, inventory(TRACKED));
		await unlink(path.join(root, "source.txt"));
		const deleted = await computeVerificationContentDigest(root, inventory(TRACKED));
		assert.notEqual(deleted.digest, initial.digest);

		await assert.rejects(computeVerificationContentDigest(root, inventory(["../escape"])), failedDigest);
	});

	it.skipIf(process.platform === "win32")("fails closed rather than aliasing invalid UTF-8 Git filenames", async () => {
		const root = await fixture();
		const replacementName = "replacement-�.txt";
		const invalidName = Buffer.concat([Buffer.from("invalid-"), Buffer.from([0x80]), Buffer.from(".txt")]);
		const invalidPath = Buffer.concat([Buffer.from(root), Buffer.from(path.sep), invalidName]);
		await writeFile(path.join(root, replacementName), "replacement\n");
		let rawFilenameSupported = true;
		try { await writeFile(invalidPath, "first\n"); }
		catch (error: any) {
			// macOS's Unicode-normalizing filesystems reject invalid byte names.
			if (error?.code !== "EILSEQ") throw error;
			rawFilenameSupported = false;
		}

		const entries = [...TRACKED, replacementName, invalidName];
		await assert.rejects(computeVerificationContentDigest(root, inventory(entries)), failedDigest);
		if (rawFilenameSupported) await writeFile(invalidPath, "changed only invalid bytes\n");
		await assert.rejects(
			computeVerificationContentDigest(root, inventory(entries)),
			failedDigest,
			"mutating only the invalid-byte entry can never reproduce a reusable digest",
		);
	});

	it.skipIf(process.platform === "win32")("fails closed for in-root and external ancestor-directory symlinks", async () => {
		const root = await fixture();
		const trackedDir = path.join(root, "tracked");
		const trackedFile = path.join(trackedDir, "file.txt");
		const entries = [...TRACKED, "tracked/file.txt"];
		await mkdir(trackedDir);
		await writeFile(trackedFile, "same source bytes\n");
		const initial = await computeVerificationContentDigest(root, inventory(entries));

		const ignoredTarget = path.join(root, "ignored");
		await mkdir(ignoredTarget);
		await writeFile(path.join(ignoredTarget, "file.txt"), "same source bytes\n");
		await rm(trackedDir, { recursive: true });
		await symlink("ignored", trackedDir, "dir");
		await assert.rejects(computeVerificationContentDigest(root, inventory(entries)), failedDigest, "an in-root ancestor symlink cannot reproduce the prior digest");

		await unlink(trackedDir);
		const outside = await mkdtemp(path.join(os.tmpdir(), "bobbit-content-digest-outside-"));
		roots.push(outside);
		await writeFile(path.join(outside, "file.txt"), "same source bytes\n");
		await symlink(outside, trackedDir, "dir");
		await assert.rejects(computeVerificationContentDigest(root, inventory(entries)), failedDigest, "an external ancestor symlink cannot read or reproduce host bytes");
		assert.ok(initial.digest, "baseline proves each malicious topology is tested against a reusable prior digest");
	});
});

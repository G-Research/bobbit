import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	computeVerificationContentDigest,
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

function inventory(tracked: string[], untracked: string[] = []) {
	return {
		execFile: async (_file: string, args: readonly string[]) => ({
			stdout: (args.includes("--cached") ? tracked : untracked).join("\0") + "\0",
			stderr: "",
		}),
	};
}

const TRACKED = [".gitignore", ".gitattributes", "text.txt", "source.txt"];

describe("computeVerificationContentDigest", () => {
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
		await chmod(path.join(root, "source.txt"), 0o755);
		assert.notEqual((await computeVerificationContentDigest(root, inventory(TRACKED))).digest, initial.digest, "executable mode enters aggregate");
	});

	it("represents tracked deletion and fails closed for unsafe inventory", async () => {
		const root = await fixture();
		const initial = await computeVerificationContentDigest(root, inventory(TRACKED));
		await unlink(path.join(root, "source.txt"));
		const deleted = await computeVerificationContentDigest(root, inventory(TRACKED));
		assert.notEqual(deleted.digest, initial.digest);

		await assert.rejects(
			computeVerificationContentDigest(root, inventory(["../escape"])),
			(error: unknown) => error instanceof VerificationContentDigestError && error.code === "VERIFICATION_CONTENT_DIGEST_FAILED",
		);
	});
});

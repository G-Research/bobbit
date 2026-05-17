/**
 * Unit tests for the lossless Continue-Archived helpers.
 *
 * Covers:
 *   - `formatAgentSessionFilePath` round-trips through the parser regex
 *     in `session-manager.ts::recoverSessionFile`.
 *   - `sessionFileCopy` non-sandboxed: byte-verbatim, creates parent dirs,
 *     rejects on missing source.
 *   - `sessionFileCopy` cross-realm: throws `CrossRealmCopyError`.
 *   - `copyToolContentDirIfPresent`: no-op when absent; recursive copy
 *     when present.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { formatAgentSessionFilePath, slugifyCwd, formatAgentTimestamp } from "../src/server/agent/agent-session-path.js";
import { sessionFileCopy, CrossRealmCopyError } from "../src/server/agent/session-fs.js";
import {
	copyToolContentDirIfPresent,
	copyProposalDirIfPresent,
	cleanupFailedContinue,
} from "../src/server/agent/continue-archived.js";

function tmpDir(label: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-${label}-`));
	return dir;
}

describe("formatAgentSessionFilePath", () => {
	it("produces a path that round-trips through recoverSessionFile's regex", () => {
		const cwd = "/home/user/proj/with-some-dir";
		const createdAt = Date.parse("2026-04-03T15:15:12.009Z");
		const id = "abc-uuid";
		const p = formatAgentSessionFilePath(cwd, createdAt, id);

		// Filename portion
		const filename = path.basename(p);
		const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)\.jsonl$/);
		assert.ok(match, `filename "${filename}" did not match agent CLI regex`);
		assert.equal(match![2], id);

		// Round-trip the timestamp
		const isoStr = match![1].replace(
			/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
			"$1-$2-$3T$4:$5:$6.$7Z",
		);
		assert.equal(new Date(isoStr).getTime(), createdAt);

		// Slug correctness
		const dir = path.basename(path.dirname(p));
		assert.equal(dir, `--${slugifyCwd(cwd)}--`);
	});

	it("handles Windows-like cwd paths (backslashes, drive letters)", () => {
		const cwd = "C:\\Users\\jane\\proj";
		const createdAt = Date.now();
		const id = randomUUID();
		const p = formatAgentSessionFilePath(cwd, createdAt, id);

		// Forward-slashes only — the formatter normalises for portability.
		assert.ok(!p.includes("\\"), `path should not contain backslashes: ${p}`);
		// Slug: every non-alphanumeric → "-"
		const slug = slugifyCwd(cwd);
		assert.ok(p.includes(`--${slug}--`));
	});

	it("formatAgentTimestamp replaces both : and .", () => {
		const ts = formatAgentTimestamp(Date.parse("2026-04-03T15:15:12.009Z"));
		assert.equal(ts, "2026-04-03T15-15-12-009Z");
	});
});

describe("sessionFileCopy (non-sandboxed)", () => {
	it("byte-verbatim copy including binary content", async () => {
		const dir = tmpDir("copy");
		try {
			const src = path.join(dir, "src.jsonl");
			const dst = path.join(dir, "nested", "deep", "dst.jsonl");
			// Mix of text + random binary bytes
			const bytes = Buffer.concat([
				Buffer.from('{"type":"message","content":"hello"}\n', "utf-8"),
				Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe]),
				Buffer.from("\n", "utf-8"),
			]);
			fs.writeFileSync(src, bytes);

			await sessionFileCopy(
				{ sandboxed: false },
				src,
				{ sandboxed: false },
				dst,
				null,
			);

			assert.ok(fs.existsSync(dst), "destination should exist");
			const got = fs.readFileSync(dst);
			assert.ok(got.equals(bytes), "destination bytes must match source verbatim");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates parent directories", async () => {
		const dir = tmpDir("copy-mkdir");
		try {
			const src = path.join(dir, "src.jsonl");
			const dst = path.join(dir, "a", "b", "c", "out.jsonl");
			fs.writeFileSync(src, "x");
			await sessionFileCopy({ sandboxed: false }, src, { sandboxed: false }, dst, null);
			assert.ok(fs.existsSync(dst));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects on missing source", async () => {
		const dir = tmpDir("copy-missing");
		try {
			const src = path.join(dir, "does-not-exist.jsonl");
			const dst = path.join(dir, "dst.jsonl");
			await assert.rejects(
				sessionFileCopy({ sandboxed: false }, src, { sandboxed: false }, dst, null),
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cross-realm (host→sandbox) throws CrossRealmCopyError", async () => {
		await assert.rejects(
			sessionFileCopy(
				{ sandboxed: false },
				"/tmp/src.jsonl",
				{ sandboxed: true, projectId: "p1" },
				"/tmp/dst.jsonl",
				null,
			),
			(err: unknown) => err instanceof CrossRealmCopyError,
		);
	});

	it("cross-realm (sandbox→host) throws CrossRealmCopyError", async () => {
		await assert.rejects(
			sessionFileCopy(
				{ sandboxed: true, projectId: "p1" },
				"/tmp/src.jsonl",
				{ sandboxed: false },
				"/tmp/dst.jsonl",
				null,
			),
			(err: unknown) => err instanceof CrossRealmCopyError,
		);
	});

	it("cross-project sandbox→sandbox throws CrossRealmCopyError", async () => {
		await assert.rejects(
			sessionFileCopy(
				{ sandboxed: true, projectId: "p1" },
				"/tmp/src.jsonl",
				{ sandboxed: true, projectId: "p2" },
				"/tmp/dst.jsonl",
				null,
			),
			(err: unknown) => err instanceof CrossRealmCopyError,
		);
	});
});

describe("copyToolContentDirIfPresent", () => {
	it("no-op when source dir is absent", () => {
		const stateDir = tmpDir("toolcontent-noop");
		try {
			// Should not throw, should not create anything.
			copyToolContentDirIfPresent("src-id", "dst-id", stateDir);
			assert.ok(!fs.existsSync(path.join(stateDir, "tool-content", "dst-id")));
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("recursively copies nested files when source dir exists", () => {
		const stateDir = tmpDir("toolcontent-copy");
		try {
			const srcRoot = path.join(stateDir, "tool-content", "src-id");
			fs.mkdirSync(path.join(srcRoot, "0"), { recursive: true });
			fs.writeFileSync(path.join(srcRoot, "0", "1.txt"), "block-1-content");
			fs.writeFileSync(path.join(srcRoot, "top.txt"), "top-content");

			copyToolContentDirIfPresent("src-id", "dst-id", stateDir);

			const dstRoot = path.join(stateDir, "tool-content", "dst-id");
			assert.equal(fs.readFileSync(path.join(dstRoot, "0", "1.txt"), "utf-8"), "block-1-content");
			assert.equal(fs.readFileSync(path.join(dstRoot, "top.txt"), "utf-8"), "top-content");
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
});

// ── copyProposalDirIfPresent + cleanupFailedContinue ─────────────────────
//
// These helpers underpin Path B of the reopen-archived-proposals design:
// continuing an archived assistant session must clone the source's
// `<stateDir>/proposal-drafts/<sessionId>/` directory verbatim (live
// `<type>.{md,yaml}` plus the entire `<type>.history/<rev>.<ext>` snapshot
// tree) so the new agent picks up the in-progress draft and rev counter
// without colliding. The cleanup helper must remove the cloned dir when
// the continue flow fails part-way through.

function seedDraft(stateDir: string, sessionId: string): void {
	const root = path.join(stateDir, "proposal-drafts", sessionId);
	fs.mkdirSync(path.join(root, "goal.history"), { recursive: true });
	fs.writeFileSync(path.join(root, "goal.md"), "live draft contents\n");
	fs.writeFileSync(path.join(root, "goal.history", "1.md"), "snapshot rev 1\n");
	fs.writeFileSync(path.join(root, "goal.history", "2.md"), "snapshot rev 2\n");
}

describe("copyProposalDirIfPresent", () => {
	it("clones the live file plus every history snapshot byte-identical", () => {
		const stateDir = tmpDir("proposal-clone");
		try {
			seedDraft(stateDir, "src");

			copyProposalDirIfPresent("src", "dst", stateDir);

			const srcRoot = path.join(stateDir, "proposal-drafts", "src");
			const dstRoot = path.join(stateDir, "proposal-drafts", "dst");

			for (const rel of ["goal.md", "goal.history/1.md", "goal.history/2.md"]) {
				const a = fs.readFileSync(path.join(srcRoot, rel));
				const b = fs.readFileSync(path.join(dstRoot, rel));
				assert.ok(b.equals(a), `mismatch for ${rel}`);
			}
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("is a silent no-op when the source directory is absent", () => {
		const stateDir = tmpDir("proposal-clone-missing");
		try {
			copyProposalDirIfPresent("nope", "dst", stateDir);
			assert.ok(!fs.existsSync(path.join(stateDir, "proposal-drafts", "dst")));
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("is idempotent \u2014 running twice does not throw and leaves the clone intact", () => {
		const stateDir = tmpDir("proposal-clone-idem");
		try {
			seedDraft(stateDir, "src");
			copyProposalDirIfPresent("src", "dst", stateDir);
			// Second call must not throw; existing destination is overwritten.
			copyProposalDirIfPresent("src", "dst", stateDir);

			const dstRoot = path.join(stateDir, "proposal-drafts", "dst");
			assert.equal(
				fs.readFileSync(path.join(dstRoot, "goal.md"), "utf-8"),
				"live draft contents\n",
			);
			assert.equal(
				fs.readFileSync(path.join(dstRoot, "goal.history", "1.md"), "utf-8"),
				"snapshot rev 1\n",
			);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("does not touch sibling sessions' drafts", () => {
		const stateDir = tmpDir("proposal-clone-isolation");
		try {
			seedDraft(stateDir, "src");
			seedDraft(stateDir, "other");

			copyProposalDirIfPresent("src", "dst", stateDir);

			// "other" remains untouched
			const otherFile = path.join(stateDir, "proposal-drafts", "other", "goal.md");
			assert.equal(fs.readFileSync(otherFile, "utf-8"), "live draft contents\n");
			assert.ok(fs.existsSync(path.join(stateDir, "proposal-drafts", "dst")));
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
});

describe("cleanupFailedContinue (proposal-dir branch)", () => {
	it("removes the cloned proposal-drafts directory", () => {
		const stateDir = tmpDir("cleanup-proposal");
		try {
			seedDraft(stateDir, "src");
			copyProposalDirIfPresent("src", "dst", stateDir);
			const dstRoot = path.join(stateDir, "proposal-drafts", "dst");
			assert.ok(fs.existsSync(dstRoot));

			cleanupFailedContinue(undefined, "dst", stateDir);

			assert.ok(!fs.existsSync(dstRoot));
			// Source must remain intact — cleanup only touches the new session id.
			assert.ok(fs.existsSync(path.join(stateDir, "proposal-drafts", "src")));
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("removes the cloned .jsonl, tool-content dir, and proposal dir together", () => {
		const stateDir = tmpDir("cleanup-multi");
		try {
			seedDraft(stateDir, "src");
			copyProposalDirIfPresent("src", "dst", stateDir);

			// Seed a tool-content dir and a placeholder destJsonl too.
			const toolDir = path.join(stateDir, "tool-content", "dst");
			fs.mkdirSync(toolDir, { recursive: true });
			fs.writeFileSync(path.join(toolDir, "0.json"), "{}");
			const destJsonl = path.join(stateDir, "session.jsonl");
			fs.writeFileSync(destJsonl, "irrelevant\n");

			cleanupFailedContinue(destJsonl, "dst", stateDir);

			assert.ok(!fs.existsSync(destJsonl));
			assert.ok(!fs.existsSync(toolDir));
			assert.ok(!fs.existsSync(path.join(stateDir, "proposal-drafts", "dst")));
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("is best-effort when the directory is already gone", () => {
		const stateDir = tmpDir("cleanup-noop");
		try {
			// Must not throw even though nothing was ever cloned.
			cleanupFailedContinue(undefined, "missing", stateDir);
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
});

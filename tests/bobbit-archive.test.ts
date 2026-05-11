/**
 * Unit tests for archiveProjectBobbitDir() — see docs/design/robust-add-project.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { archiveProjectBobbitDir, ArchiveError, GATEWAY_OWNED_FILES, isPreserved } from "../src/server/agent/bobbit-archive.js";

function mkTmp(prefix = "bobbit-archive-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedMixedBobbit(root: string) {
	const bobbit = path.join(root, ".bobbit");
	fs.mkdirSync(path.join(bobbit, "config"), { recursive: true });
	fs.mkdirSync(path.join(bobbit, "state"), { recursive: true });
	fs.mkdirSync(path.join(bobbit, "state", "tls"), { recursive: true });
	fs.mkdirSync(path.join(bobbit, "state", "goals"), { recursive: true });

	// Project-scoped (will be archived)
	fs.writeFileSync(path.join(bobbit, "config", "system-prompt.md"), "# prompt");
	fs.writeFileSync(path.join(bobbit, "state", "goals", "goals.json"), "[]");
	fs.writeFileSync(path.join(bobbit, "state", "some-random-state.json"), "{}");

	// Gateway-owned
	fs.writeFileSync(path.join(bobbit, "state", "gateway-url"), "https://x");
	fs.writeFileSync(path.join(bobbit, "state", "watchdog.json"), "{}");
	fs.writeFileSync(path.join(bobbit, "state", "tls", "ca.crt"), "cert");
	fs.writeFileSync(path.join(bobbit, "state", "model-name-abc.txt"), "claude");
}

test("isPreserved matches dir-roots and prefix patterns", () => {
	assert.deepEqual(isPreserved("state/tls", GATEWAY_OWNED_FILES), { preserved: true, isDirRoot: true });
	assert.deepEqual(isPreserved("state/tls/ca.crt", GATEWAY_OWNED_FILES), { preserved: true, isDirRoot: false });
	assert.deepEqual(isPreserved("state/gateway-url", GATEWAY_OWNED_FILES), { preserved: true, isDirRoot: false });
	assert.deepEqual(isPreserved("state/model-name-foo.txt", GATEWAY_OWNED_FILES), { preserved: true, isDirRoot: false });
	assert.deepEqual(isPreserved("config/system-prompt.md", GATEWAY_OWNED_FILES).preserved, false);
	assert.deepEqual(isPreserved("state/goals/goals.json", GATEWAY_OWNED_FILES).preserved, false);
});

test("throws no-bobbit-dir when .bobbit/ is absent", () => {
	const tmp = mkTmp();
	try {
		assert.throws(
			() => archiveProjectBobbitDir(tmp, { gatewayOwned: false }),
			(err: unknown) => err instanceof ArchiveError && (err as ArchiveError).code === "no-bobbit-dir",
		);
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("throws empty-bobbit-dir when .bobbit/ has only empty subdirs", () => {
	const tmp = mkTmp();
	try {
		fs.mkdirSync(path.join(tmp, ".bobbit", "config"), { recursive: true });
		fs.mkdirSync(path.join(tmp, ".bobbit", "state"), { recursive: true });
		assert.throws(
			() => archiveProjectBobbitDir(tmp, { gatewayOwned: false }),
			(err: unknown) => err instanceof ArchiveError && (err as ArchiveError).code === "empty-bobbit-dir",
		);
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("gatewayOwned=false → archives everything; .bobbit/ rescaffolded empty", () => {
	const tmp = mkTmp();
	try {
		seedMixedBobbit(tmp);
		const res = archiveProjectBobbitDir(tmp, { gatewayOwned: false });
		assert.match(res.archiveDir, /\.bobbit-archive-001$/);
		assert.equal(res.preservedPaths.length, 0);
		// With gatewayOwned=false the allowlist is empty, so whole top-level
		// dirs (state/, config/) move as single units rather than enumerating
		// every leaf file. Just assert that everything actually moved.
		assert.ok(res.movedPaths.includes("state") || res.movedPaths.some(p => p.includes("gateway-url")));
		assert.ok(res.movedPaths.includes("config") || res.movedPaths.some(p => p.includes("system-prompt.md")));
		// .bobbit/ rescaffolded empty
		const stateChildren = fs.readdirSync(path.join(tmp, ".bobbit", "state"));
		assert.deepEqual(stateChildren, []);
		// Archive contains gateway-url
		assert.ok(fs.existsSync(path.join(res.archiveDir, "state", "gateway-url")));
		// Manifest exists
		assert.ok(fs.existsSync(path.join(res.archiveDir, "MANIFEST.json")));
		const manifest = JSON.parse(fs.readFileSync(path.join(res.archiveDir, "MANIFEST.json"), "utf-8"));
		assert.equal(manifest.gatewayOwned, false);
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("gatewayOwned=true → preserves allowlist files, archives the rest", () => {
	const tmp = mkTmp();
	try {
		seedMixedBobbit(tmp);
		const res = archiveProjectBobbitDir(tmp, { gatewayOwned: true });
		// Preserved
		assert.ok(fs.existsSync(path.join(tmp, ".bobbit", "state", "gateway-url")));
		assert.ok(fs.existsSync(path.join(tmp, ".bobbit", "state", "watchdog.json")));
		assert.ok(fs.existsSync(path.join(tmp, ".bobbit", "state", "tls", "ca.crt")));
		assert.ok(fs.existsSync(path.join(tmp, ".bobbit", "state", "model-name-abc.txt")));
		// Archived
		assert.ok(!fs.existsSync(path.join(tmp, ".bobbit", "config", "system-prompt.md")));
		assert.ok(fs.existsSync(path.join(res.archiveDir, "config", "system-prompt.md")));
		assert.ok(fs.existsSync(path.join(res.archiveDir, "state", "goals", "goals.json")));
		// preservedPaths includes gateway-url, watchdog.json, tls dir, model-name
		const ps = res.preservedPaths.join("\n");
		assert.match(ps, /state\/gateway-url/);
		assert.match(ps, /state\/watchdog\.json/);
		assert.match(ps, /state\/tls/);
		assert.match(ps, /model-name-abc\.txt/);
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("second archive lands in .bobbit-archive-002/", () => {
	const tmp = mkTmp();
	try {
		seedMixedBobbit(tmp);
		const r1 = archiveProjectBobbitDir(tmp, { gatewayOwned: false });
		assert.match(r1.archiveDir, /-001$/);
		// Seed again
		seedMixedBobbit(tmp);
		const r2 = archiveProjectBobbitDir(tmp, { gatewayOwned: false });
		assert.match(r2.archiveDir, /-002$/);
		// Both archives exist
		assert.ok(fs.existsSync(r1.archiveDir));
		assert.ok(fs.existsSync(r2.archiveDir));
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("preserved directory subtree is recorded as a unit, not recursed into", () => {
	const tmp = mkTmp();
	try {
		seedMixedBobbit(tmp);
		// Add multiple files under state/tls so we can verify subtree treatment
		fs.writeFileSync(path.join(tmp, ".bobbit", "state", "tls", "server.crt"), "x");
		fs.writeFileSync(path.join(tmp, ".bobbit", "state", "tls", "server.key"), "x");
		const res = archiveProjectBobbitDir(tmp, { gatewayOwned: true });
		// state/tls is preserved as a whole; preservedPaths should contain
		// the dir entry, not each individual file.
		const tlsEntries = res.preservedPaths.filter(p => p.startsWith("state/tls"));
		assert.deepEqual(tlsEntries, ["state/tls"], `got: ${JSON.stringify(tlsEntries)}`);
		// All files remain on disk
		assert.ok(fs.existsSync(path.join(tmp, ".bobbit", "state", "tls", "ca.crt")));
		assert.ok(fs.existsSync(path.join(tmp, ".bobbit", "state", "tls", "server.crt")));
		assert.ok(fs.existsSync(path.join(tmp, ".bobbit", "state", "tls", "server.key")));
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("EXDEV from fs.renameSync triggers copy+unlink fallback", () => {
	const tmp = mkTmp();
	const origRename = fs.renameSync;
	let triggered = false;
	try {
		seedMixedBobbit(tmp);
		const targetBasename = "some-random-state.json";
		// Stub: throw EXDEV exactly once for the target file path.
		(fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = function (src, dst) {
			if (!triggered && typeof src === "string" && src.endsWith(targetBasename)) {
				triggered = true;
				const err = new Error("EXDEV: cross-device link not permitted (stubbed)") as Error & { code?: string };
				err.code = "EXDEV";
				throw err;
			}
			return origRename.call(fs, src, dst);
		} as typeof fs.renameSync;

		// gatewayOwned=true so the walker recurses into state/ and hits the file at leaf level.
		const res = archiveProjectBobbitDir(tmp, { gatewayOwned: true });

		assert.equal(triggered, true, "stubbed renameSync was never called for the target path");
		// File must have moved: present in archive, absent in original tree.
		assert.ok(
			fs.existsSync(path.join(res.archiveDir, "state", targetBasename)),
			"target file should be present under archive after EXDEV fallback",
		);
		assert.ok(
			!fs.existsSync(path.join(tmp, ".bobbit", "state", targetBasename)),
			"target file should be removed from original .bobbit/ after fallback",
		);
		assert.ok(
			res.movedPaths.includes("state/" + targetBasename),
			`movedPaths should include the target: ${JSON.stringify(res.movedPaths)}`,
		);
		// No partial failure recorded for this entry.
		const failedPaths = res.partial?.failed.map(f => f.path) ?? [];
		assert.ok(
			!failedPaths.includes("state/" + targetBasename),
			`EXDEV path should NOT appear in partial.failed: ${JSON.stringify(failedPaths)}`,
		);
	} finally {
		(fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = origRename;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("partial failure: one unmovable entry is recorded; siblings still archive; no rollback", () => {
	const tmp = mkTmp();
	const origRename = fs.renameSync;
	let triggered = false;
	try {
		seedMixedBobbit(tmp);
		const lockedBasename = "some-random-state.json";
		// Use EACCES — the implementation falls back on EXDEV/EPERM but propagates other codes.
		// This is the only way to actually exercise the partial-failure path with a stub.
		(fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = function (src, dst) {
			if (!triggered && typeof src === "string" && src.endsWith(lockedBasename)) {
				triggered = true;
				const err = new Error("EACCES: locked by another process (stubbed)") as Error & { code?: string };
				err.code = "EACCES";
				throw err;
			}
			return origRename.call(fs, src, dst);
		} as typeof fs.renameSync;

		const res = archiveProjectBobbitDir(tmp, { gatewayOwned: true });

		assert.equal(triggered, true, "stubbed renameSync was never called for the locked path");

		// Failure recorded.
		assert.ok(res.partial, "result.partial should be set when an entry fails");
		const failed = res.partial!.failed;
		const lockedEntry = failed.find(f => f.path === "state/" + lockedBasename);
		assert.ok(lockedEntry, `partial.failed should include locked entry; got ${JSON.stringify(failed)}`);
		assert.match(lockedEntry!.error, /EACCES/);

		// Sibling archived successfully (config/system-prompt.md).
		assert.ok(
			fs.existsSync(path.join(res.archiveDir, "config", "system-prompt.md")),
			"sibling entries should still be archived despite one failure",
		);
		assert.ok(
			!fs.existsSync(path.join(tmp, ".bobbit", "config", "system-prompt.md")),
			"sibling source should be removed after successful archive",
		);

		// No rollback: locked file still on disk in the original tree.
		assert.ok(
			fs.existsSync(path.join(tmp, ".bobbit", "state", lockedBasename)),
			"locked file should remain in the original tree (no rollback)",
		);

		// MANIFEST.json written regardless of partial failure.
		const manifestPath = path.join(res.archiveDir, "MANIFEST.json");
		assert.ok(fs.existsSync(manifestPath), "MANIFEST.json should be written even on partial failure");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		assert.ok(manifest.partial?.failed?.length >= 1, "manifest should record partial failures");
	} finally {
		(fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = origRename;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("custom allowlist used when supplied", () => {
	const tmp = mkTmp();
	try {
		seedMixedBobbit(tmp);
		const res = archiveProjectBobbitDir(tmp, { gatewayOwned: true, allowlist: [] });
		assert.equal(res.preservedPaths.length, 0);
		// gateway-url got archived
		assert.ok(!fs.existsSync(path.join(tmp, ".bobbit", "state", "gateway-url")));
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

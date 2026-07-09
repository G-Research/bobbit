import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Import the chaos runner as a namespace. The module is CLI-guarded, so importing
// it must NOT run a campaign — it only exposes the FS-safety helpers.
import * as chaos from "../../scripts/testing-v2/chaos.mjs";

/**
 * Reproducing test for the chaos.mjs node_modules-wipe goal.
 *
 * Bug: chaos.mjs put a Windows directory junction `node_modules` INSIDE each
 * throwaway git worktree, then force-deleted the worktree. On Windows the
 * recursive delete descends THROUGH the junction and wipes the shared/primary
 * node_modules (the target), bricking the running gateway.
 *
 * Decided fix (implemented by another agent): a campaign-scoped "chaos root"
 * with ONE shared node_modules junction and worktrees as siblings with NO inner
 * node_modules, plus junction-safe teardown helpers:
 *   - `unlinkReparsePoint(p)` — removes ONLY the link, never follows it.
 *   - `cleanupChaosRoot(root)` — unlinks the reparse point first, then rm -rf.
 * and the in-worktree junction creator `ensureNodeModulesJunction` is REMOVED.
 *
 * These assertions pin that future API against the current HEAD, so they FAIL
 * now (helpers absent, `ensureNodeModulesJunction` still defined) and PASS after
 * the fix. Temp-FS only — no git, no network, no docker (external-free core tier).
 */

const isWindows = process.platform === "win32";
// Windows junctions require an ABSOLUTE target; POSIX dir symlinks accept either.
const LINK_TYPE: "junction" | "dir" = isWindows ? "junction" : "dir";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

/** Create a directory reparse point (junction on Windows, dir symlink on POSIX). */
function linkToDir(target: string, link: string): void {
	fs.symlinkSync(path.resolve(target), link, LINK_TYPE);
}

afterEach(() => {
	// Best-effort cleanup of every temp dir this test created. We deliberately
	// unlink any reparse point BEFORE recursive delete so our own teardown can
	// never reproduce the very bug under test.
	for (const root of tempRoots.splice(0)) {
		try {
			const nm = path.join(root, "node_modules");
			const st = fs.lstatSync(nm);
			if (st.isSymbolicLink()) fs.unlinkSync(nm);
			else if (isWindows && st.isDirectory()) {
				try { fs.rmdirSync(nm); } catch { /* not a junction */ }
			}
		} catch { /* no node_modules link */ }
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

describe("chaos.mjs worktree teardown is junction-safe (node_modules-wipe reproducing test)", () => {
	it("unlinkReparsePoint removes only the link and preserves the external junction target", () => {
		expect(
			typeof (chaos as Record<string, unknown>).unlinkReparsePoint,
			"REPRO-FAIL: chaos.unlinkReparsePoint is not a function (junction-safe unlink helper missing)",
		).toBe("function");

		// External sentinel dir (stands in for the shared/primary node_modules)
		// living OUTSIDE the dir we will operate on.
		const sentinel = makeTempDir("bobbit-chaos-sentinel-");
		const marker = path.join(sentinel, "MARKER.txt");
		fs.writeFileSync(marker, "do-not-delete", "utf-8");

		// A container dir with a `node_modules` reparse point → the sentinel.
		const container = makeTempDir("bobbit-chaos-container-");
		const link = path.join(container, "node_modules");
		linkToDir(sentinel, link);

		const unlinkReparsePoint = (chaos as { unlinkReparsePoint: (p: string) => void }).unlinkReparsePoint;
		unlinkReparsePoint(link);

		// The link is gone …
		expect(fs.existsSync(link), "REPRO-FAIL: reparse point still present after unlinkReparsePoint").toBe(false);
		// … but the external sentinel dir and its marker survive untouched.
		expect(fs.existsSync(sentinel), "REPRO-FAIL: external junction target dir was deleted through the link").toBe(true);
		expect(fs.existsSync(marker), "REPRO-FAIL: external junction target marker file was deleted through the link").toBe(true);
		expect(fs.readFileSync(marker, "utf-8")).toBe("do-not-delete");
	});

	it("cleanupChaosRoot removes the chaos root but never deletes through the node_modules junction", () => {
		expect(
			typeof (chaos as Record<string, unknown>).cleanupChaosRoot,
			"REPRO-FAIL: chaos.cleanupChaosRoot is not a function (campaign-scoped teardown helper missing)",
		).toBe("function");

		// External sentinel dir with a marker file — MUST survive cleanup.
		const sentinel = makeTempDir("bobbit-chaos-sentinel2-");
		const marker = path.join(sentinel, "MARKER.txt");
		fs.writeFileSync(marker, "shared-node-modules", "utf-8");

		// Fabricated chaos root: (i) node_modules junction → external sentinel,
		// (ii) a dummy worktree sibling dir with a file.
		const chaosRoot = makeTempDir("bobbit-chaos-root-");
		linkToDir(sentinel, path.join(chaosRoot, "node_modules"));
		const wt = path.join(chaosRoot, "wt-x");
		fs.mkdirSync(wt, { recursive: true });
		fs.writeFileSync(path.join(wt, "file.txt"), "ephemeral", "utf-8");

		const cleanupChaosRoot = (chaos as { cleanupChaosRoot: (root: string) => void }).cleanupChaosRoot;
		cleanupChaosRoot(chaosRoot);

		// The whole fabricated root is removed …
		expect(fs.existsSync(chaosRoot), "REPRO-FAIL: cleanupChaosRoot did not remove the chaos root").toBe(false);
		// … but the external sentinel dir + marker are NEVER deleted through the junction.
		expect(fs.existsSync(sentinel), "REPRO-FAIL: cleanupChaosRoot deleted through the node_modules junction into the external target").toBe(true);
		expect(fs.existsSync(marker), "REPRO-FAIL: cleanupChaosRoot deleted the external junction target marker file").toBe(true);
		expect(fs.readFileSync(marker, "utf-8")).toBe("shared-node-modules");
	});

	it("ensureNodeModulesJunction is removed (the in-worktree junction footgun can never return)", () => {
		// The fix deletes ensureNodeModulesJunction entirely — no node_modules
		// link is ever created INSIDE a throwaway worktree again.
		expect(
			(chaos as Record<string, unknown>).ensureNodeModulesJunction,
			"REPRO-FAIL: chaos.ensureNodeModulesJunction is still defined — the in-worktree node_modules junction must be removed",
		).toBeUndefined();
	});
});

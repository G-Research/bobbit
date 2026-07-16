import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// Import the chaos runner as a namespace. The module is CLI-guarded, so importing
// it must NOT run a campaign — it only exposes the FS-safety helpers.
import * as chaos from "../../scripts/testing-v2/chaos.mjs";

/**
 * Reproducing test for the chaos.mjs node_modules-wipe goal.
 *
 * The filesystem policy below models the one dangerous property of an NTFS
 * junction: recursively deleting a root while its junction remains can erase
 * the external target. Keeping the model in memory makes this safety contract
 * deterministic without creating or Defender-scanning real reparse points.
 */

type VirtualEntry =
	| { kind: "dir" }
	| { kind: "file"; content: string }
	| { kind: "junction"; target: string };

class VirtualJunctionPolicy {
	private readonly entries = new Map<string, VirtualEntry>();

	constructor() {
		vi.spyOn(fs, "existsSync").mockImplementation((entry) => this.entries.has(this.key(entry)));
		vi.spyOn(fs, "lstatSync").mockImplementation(((entry: fs.PathLike) => {
			const value = this.entries.get(this.key(entry));
			if (!value) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return {
				isDirectory: () => value.kind === "dir" || (value.kind === "junction" && process.platform === "win32"),
				isSymbolicLink: () => value.kind === "junction" && process.platform !== "win32",
			};
		}) as typeof fs.lstatSync);
		vi.spyOn(fs, "rmdirSync").mockImplementation(((entry: fs.PathLike) => this.unlinkJunction(entry)) as typeof fs.rmdirSync);
		vi.spyOn(fs, "unlinkSync").mockImplementation(((entry: fs.PathLike) => this.unlinkJunction(entry)) as typeof fs.unlinkSync);
		vi.spyOn(fs, "rmSync").mockImplementation(((entry: fs.PathLike, options?: fs.RmDirOptions) => this.remove(entry, options)) as typeof fs.rmSync);
	}

	mkdir(entry: string): void {
		this.entries.set(this.key(entry), { kind: "dir" });
	}

	write(entry: string, content: string): void {
		this.entries.set(this.key(entry), { kind: "file", content });
	}

	junction(target: string, link: string): void {
		this.entries.set(this.key(link), { kind: "junction", target: this.key(target) });
	}

	exists(entry: string): boolean {
		return this.entries.has(this.key(entry));
	}

	read(entry: string): string | undefined {
		const value = this.entries.get(this.key(entry));
		return value?.kind === "file" ? value.content : undefined;
	}

	private key(entry: fs.PathLike): string {
		return path.resolve(String(entry));
	}

	private unlinkJunction(entry: fs.PathLike): void {
		const key = this.key(entry);
		if (this.entries.get(key)?.kind !== "junction") throw new Error(`not a junction: ${key}`);
		this.entries.delete(key);
	}

	private remove(entry: fs.PathLike, options?: fs.RmDirOptions): void {
		const root = this.key(entry);
		const prefix = `${root}${path.sep}`;
		if (options?.recursive) {
			// Model the Windows footgun: a recursive delete with a live junction
			// traverses into its external target. The production helper must unlink
			// every junction before reaching this operation.
			for (const [key, value] of this.entries) {
				if ((key === root || key.startsWith(prefix)) && value.kind === "junction") {
					const targetPrefix = `${value.target}${path.sep}`;
					for (const targetKey of [...this.entries.keys()]) {
						if (targetKey === value.target || targetKey.startsWith(targetPrefix)) this.entries.delete(targetKey);
					}
				}
			}
			for (const key of [...this.entries.keys()]) {
				if (key === root || key.startsWith(prefix)) this.entries.delete(key);
			}
			return;
		}
		this.entries.delete(root);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("chaos.mjs worktree teardown is junction-safe (node_modules-wipe reproducing test)", () => {
	it("unlinkReparsePoint removes only the link and preserves the external junction target", () => {
		expect(
			typeof (chaos as Record<string, unknown>).unlinkReparsePoint,
			"REPRO-FAIL: chaos.unlinkReparsePoint is not a function (junction-safe unlink helper missing)",
		).toBe("function");

		const policy = new VirtualJunctionPolicy();
		const sentinel = path.resolve("/virtual/chaos/sentinel");
		const marker = path.join(sentinel, "MARKER.txt");
		const container = path.resolve("/virtual/chaos/container");
		const link = path.join(container, "node_modules");
		policy.mkdir(sentinel);
		policy.write(marker, "do-not-delete");
		policy.mkdir(container);
		policy.junction(sentinel, link);

		const unlinkReparsePoint = (chaos as { unlinkReparsePoint: (entry: string) => void }).unlinkReparsePoint;
		unlinkReparsePoint(link);

		expect(policy.exists(link), "REPRO-FAIL: reparse point still present after unlinkReparsePoint").toBe(false);
		expect(policy.exists(sentinel), "REPRO-FAIL: external junction target dir was deleted through the link").toBe(true);
		expect(policy.exists(marker), "REPRO-FAIL: external junction target marker file was deleted through the link").toBe(true);
		expect(policy.read(marker)).toBe("do-not-delete");
	});

	it("cleanupChaosRoot removes the chaos root but never deletes through the node_modules junction", () => {
		expect(
			typeof (chaos as Record<string, unknown>).cleanupChaosRoot,
			"REPRO-FAIL: chaos.cleanupChaosRoot is not a function (campaign-scoped teardown helper missing)",
		).toBe("function");

		const policy = new VirtualJunctionPolicy();
		const sentinel = path.resolve("/virtual/chaos/sentinel2");
		const marker = path.join(sentinel, "MARKER.txt");
		const chaosRoot = path.resolve("/virtual/chaos/root");
		const worktree = path.join(chaosRoot, "wt-x");
		policy.mkdir(sentinel);
		policy.write(marker, "shared-node-modules");
		policy.mkdir(chaosRoot);
		policy.junction(sentinel, path.join(chaosRoot, "node_modules"));
		policy.mkdir(worktree);
		policy.write(path.join(worktree, "file.txt"), "ephemeral");

		const cleanupChaosRoot = (chaos as { cleanupChaosRoot: (root: string) => void }).cleanupChaosRoot;
		cleanupChaosRoot(chaosRoot);

		expect(policy.exists(chaosRoot), "REPRO-FAIL: cleanupChaosRoot did not remove the chaos root").toBe(false);
		expect(policy.exists(sentinel), "REPRO-FAIL: cleanupChaosRoot deleted through the node_modules junction into the external target").toBe(true);
		expect(policy.exists(marker), "REPRO-FAIL: cleanupChaosRoot deleted the external junction target marker file").toBe(true);
		expect(policy.read(marker)).toBe("shared-node-modules");
	});

	it("ensureNodeModulesJunction is removed (the in-worktree junction footgun can never return)", () => {
		expect(
			(chaos as Record<string, unknown>).ensureNodeModulesJunction,
			"REPRO-FAIL: chaos.ensureNodeModulesJunction is still defined — the in-worktree node_modules junction must be removed",
		).toBeUndefined();
	});
});

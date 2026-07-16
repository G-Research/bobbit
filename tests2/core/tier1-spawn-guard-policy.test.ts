import { describe, expect, it, vi } from "vitest";
import { createTier1SpawnGuardController } from "../harness/tier1-spawn-guard.js";

const APIS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
type Api = (typeof APIS)[number];
type FakeTarget = Record<Api, (...args: unknown[]) => unknown>;

function fakeTarget(): FakeTarget {
	return Object.fromEntries(APIS.map(api => [api, vi.fn(() => api)])) as unknown as FakeTarget;
}

function messageFrom(call: () => unknown): string {
	try {
		call();
		throw new Error("expected subprocess call to be blocked");
	} catch (error) {
		return (error as Error).message;
	}
}

describe("tier-1 spawn guard policy", () => {
	it("blocks every sync and async process API with migration guidance", () => {
		const target = fakeTarget();
		const guard = createTier1SpawnGuardController(target);
		guard.install();
		const calls: Array<[Api, () => unknown]> = [
			["spawn", () => target.spawn("git", ["status"])],
			["spawnSync", () => target.spawnSync("git", ["status"])],
			["exec", () => target.exec("git status")],
			["execSync", () => target.execSync("git status")],
			["execFile", () => target.execFile("git", ["status"])],
			["execFileSync", () => target.execFileSync("git", ["status"])],
			["fork", () => target.fork("worker.mjs")],
		];

		for (const [api, call] of calls) {
			const message = messageFrom(call);
			expect(message).toContain(`child_process.${api}`);
			expect(message).toContain(api === "fork" ? "worker.mjs" : "git");
			expect(message).toContain("commandRunner/gitRunner fake");
			expect(message).toContain("copyGitTemplate()");
		}
	});

	it("synchronizes target mutations and restores original functions", () => {
		const target = fakeTarget();
		const originals = { ...target };
		const syncExports = vi.fn();
		const guard = createTier1SpawnGuardController(target, syncExports);
		const restore = guard.install();

		expect(guard.isInstalled()).toBe(true);
		expect(() => target.spawn("git", [])).toThrow(/tier1-spawn-guard.*child_process\.spawn/);
		expect(syncExports).toHaveBeenCalledTimes(1);

		restore();
		expect(guard.isInstalled()).toBe(false);
		expect(target).toEqual(originals);
		expect(syncExports).toHaveBeenCalledTimes(2);
	});

	it("is idempotent without letting a later install restore the owner", () => {
		const target = fakeTarget();
		const guard = createTier1SpawnGuardController(target);
		const ownerRestore = guard.install();
		const nonOwnerRestore = guard.install();

		nonOwnerRestore();
		expect(guard.isInstalled()).toBe(true);
		expect(() => target.spawn("git", [])).toThrow(/blocked child_process\.spawn/);
		ownerRestore();
		expect(guard.isInstalled()).toBe(false);
	});
});

import * as childProcess from "node:child_process";
import { spawn as importedBeforeGuard } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let installTier1SpawnGuard: typeof import("./tier1-spawn-guard.js").installTier1SpawnGuard;
let isTier1SpawnGuardInstalled: typeof import("./tier1-spawn-guard.js").isTier1SpawnGuardInstalled;
let restore: (() => void) | undefined;

beforeAll(async () => {
	process.env.BOBBIT_TIER1_SPAWN_GUARD_DISABLE = "1";
	try {
		({ installTier1SpawnGuard, isTier1SpawnGuardInstalled } = await import("./tier1-spawn-guard.js"));
	} finally {
		delete process.env.BOBBIT_TIER1_SPAWN_GUARD_DISABLE;
	}
});

afterEach(() => {
	restore?.();
	restore = undefined;
});

function messageFrom(call: () => unknown): string {
	try {
		call();
		throw new Error("expected child_process call to be blocked");
	} catch (error) {
		return (error as Error).message;
	}
}

describe("tier-1 spawn guard", () => {
	it("blocks every sync and async process API with migration guidance", () => {
		restore = installTier1SpawnGuard();
		const calls: Array<[string, () => unknown]> = [
			["spawn", () => childProcess.spawn("git", ["status"])],
			["spawnSync", () => childProcess.spawnSync("git", ["status"])],
			["exec", () => childProcess.exec("git status")],
			["execSync", () => childProcess.execSync("git status")],
			["execFile", () => childProcess.execFile("git", ["status"])],
			["execFileSync", () => childProcess.execFileSync("git", ["status"])],
			["fork", () => childProcess.fork("worker.mjs")],
		];
		for (const [api, call] of calls) {
			const message = messageFrom(call);
			expect(message).toContain(`child_process.${api}`);
			expect(message).toContain(api === "fork" ? "worker.mjs" : "git");
			expect(message).toContain("commandRunner/gitRunner fake");
			expect(message).toContain("copyGitTemplate()");
		}
	});

	it("updates built-in ESM bindings imported before installation and restores them", () => {
		restore = installTier1SpawnGuard();
		expect(() => importedBeforeGuard("git", ["status"])).toThrow(/tier1-spawn-guard.*child_process\.spawn/);
		expect(isTier1SpawnGuardInstalled()).toBe(true);

		restore();
		restore = undefined;
		expect(isTier1SpawnGuardInstalled()).toBe(false);
		expect(importedBeforeGuard).toBe(childProcess.spawn);
	});

	it("is idempotent without letting a later install restore the owner", () => {
		restore = installTier1SpawnGuard();
		const nonOwnerRestore = installTier1SpawnGuard();
		nonOwnerRestore();
		expect(isTier1SpawnGuardInstalled()).toBe(true);
		expect(() => childProcess.spawn("git", [])).toThrow(/blocked child_process\.spawn/);
	});
});

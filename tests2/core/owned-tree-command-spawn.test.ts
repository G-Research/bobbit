import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { realClock } from "../../src/server/clock.js";
import {
	createCommandSpawnAdapter,
	hasOwnedTreeSpawnRequest,
	ownedTreeSpawnOptions,
	type OwnedTreeControl,
} from "../../src/server/owned-tree-command-spawn.js";

function fakeChild(): ChildProcess {
	return new EventEmitter() as ChildProcess;
}

describe("owned-tree CommandRunner spawn adapter", () => {
	it("keeps ordinary spawn direct and byte-compatible", () => {
		const child = fakeChild();
		const options: SpawnOptions = { cwd: "fixture", windowsHide: false };
		const direct = vi.fn(() => child);
		const owned = vi.fn();
		const spawn = createCommandSpawnAdapter(direct, owned as any);

		expect(spawn("git", ["status"], options)).toBe(child);
		expect(direct).toHaveBeenCalledWith("git", ["status"], options);
		expect(owned).not.toHaveBeenCalled();
	});

	it("translates only a branded logical spawn through spawnTracked defaults and binds control synchronously", () => {
		const child = fakeChild();
		const control: OwnedTreeControl & { child: ChildProcess } = {
			child,
			ownershipReady: Promise.resolve(),
			killTree: vi.fn(),
			waitForTreeExit: vi.fn(async () => true),
			killed: () => false,
			timedOut: () => false,
		};
		const direct = vi.fn();
		const owned = vi.fn((_file: string, _args: readonly string[], options: Record<string, unknown>) => {
			// Absence of both overrides is the security invariant: spawnTracked chooses
			// its production POSIX sentinel or pre-resume Windows Job itself.
			expect(options.spawnImpl).toBeUndefined();
			expect(options.platform).toBeUndefined();
			return control;
		});
		const spawn = createCommandSpawnAdapter(direct as any, owned as any);
		let bound: OwnedTreeControl | undefined;
		const options = ownedTreeSpawnOptions({
			cwd: "neutral",
			env: { GIT_TERMINAL_PROMPT: "0" },
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		}, realClock, value => { bound = value; });

		expect(hasOwnedTreeSpawnRequest(options)).toBe(true);
		expect(spawn("git", ["credential", "fill"], options)).toBe(child);
		expect(bound).toBe(control);
		expect(direct).not.toHaveBeenCalled();
		expect(owned).toHaveBeenCalledTimes(1);
		expect(owned.mock.calls[0]?.[0]).toBe("git");
		expect(owned.mock.calls[0]?.[1]).toEqual(["credential", "fill"]);
		expect(hasOwnedTreeSpawnRequest(owned.mock.calls[0]?.[2] as SpawnOptions)).toBe(false);
	});

	it("force-kills the owned tree when synchronous binding fails", () => {
		const child = fakeChild();
		const killTree = vi.fn();
		const owned = vi.fn(() => ({
			child,
			ownershipReady: Promise.resolve(),
			killTree,
			waitForTreeExit: async () => true,
			killed: () => false,
			timedOut: () => false,
		}));
		const spawn = createCommandSpawnAdapter(vi.fn() as any, owned as any);
		const options = ownedTreeSpawnOptions({}, realClock, () => { throw new Error("bind failed"); });

		expect(() => spawn("git", ["credential", "fill"], options)).toThrow("bind failed");
		expect(killTree).toHaveBeenCalledWith("SIGKILL");
	});
});

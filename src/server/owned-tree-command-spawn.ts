import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Clock } from "./clock.js";
import { spawnTracked, type TrackedChild } from "./agent/spawn-tree.js";

const OWNED_TREE_REQUEST = Symbol("bobbit.owned-tree-command-spawn");

export type OwnedTreeControl = Pick<TrackedChild,
	| "ownershipReady"
	| "killTree"
	| "waitForTreeExit"
	| "killed"
	| "timedOut"
>;

interface OwnedTreeRequest {
	clock: Clock;
	bind(control: OwnedTreeControl): void;
}

export type CommandSpawnOptions = SpawnOptions & {
	[OWNED_TREE_REQUEST]?: OwnedTreeRequest;
};

/**
 * Brand one logical CommandRunner spawn as requiring platform-owned process-tree
 * containment. The symbol stays private so only this module can translate the
 * request into the lower-level sentinel/Job supervisor.
 */
export function ownedTreeSpawnOptions(
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		stdio?: SpawnOptions["stdio"];
		windowsHide?: boolean;
	},
	clock: Clock,
	bind: (control: OwnedTreeControl) => void,
): CommandSpawnOptions {
	return Object.assign({}, options, {
		[OWNED_TREE_REQUEST]: { clock, bind } satisfies OwnedTreeRequest,
	});
}

export function hasOwnedTreeSpawnRequest(options: CommandSpawnOptions | undefined): boolean {
	return options?.[OWNED_TREE_REQUEST] !== undefined;
}

type DirectSpawn = (file: string, args: readonly string[], options?: SpawnOptions) => ChildProcess;
type OwnedSpawn = typeof spawnTracked;

/** Production CommandRunner spawn adapter. Ordinary calls retain direct-spawn behavior. */
export function createCommandSpawnAdapter(
	directSpawn: DirectSpawn = (file, args, options) => options === undefined
		? nodeSpawn(file, [...args])
		: nodeSpawn(file, [...args], options),
	ownedSpawn: OwnedSpawn = spawnTracked,
): NonNullable<import("./gateway-deps.js").CommandRunner["spawn"]> {
	return (file, args, options) => {
		const request = options?.[OWNED_TREE_REQUEST];
		if (!request) return directSpawn(file, args, options);

		const { [OWNED_TREE_REQUEST]: _request, ...spawnOptions } = options;
		if (spawnOptions.cwd != null && typeof spawnOptions.cwd !== "string") {
			throw new Error("Owned-tree command cwd must be a filesystem path string");
		}
		const tracked = ownedSpawn(file, args, {
			cwd: spawnOptions.cwd,
			env: spawnOptions.env,
			stdio: spawnOptions.stdio,
			windowsHide: spawnOptions.windowsHide,
			clock: request.clock,
		});
		try {
			request.bind(tracked);
		} catch (error) {
			// Binding is part of the synchronous ownership handoff. If a caller cannot
			// retain the control, do not leave the newly owned tree running.
			tracked.killTree("SIGKILL");
			throw error;
		}
		return tracked.child;
	};
}

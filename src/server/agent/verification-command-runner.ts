/**
 * DI seam for the verification COMMAND-STEP executor.
 *
 * This is deliberately SEPARATE from the git `CommandRunner` in gateway-deps.ts
 * (which stays as-is). It abstracts ONLY the point at which a verification
 * command step launches a tracked child process — the durable detached-shell /
 * attached-pipe path in `VerificationHarness.runCommandStep`.
 *
 * WHY: each command step (e.g. a workflow's `{ type:"command", run:"echo ok" }`)
 * spawns a real shell (`cmd.exe` / Git-Bash) that is NOT counted by the v2
 * concurrency ledger's worker budget. Under N-way `test:v2` load these
 * uncounted spawns oversubscribe the box and starve the heavy gateway
 * integration tests into their wall-clock timeouts (see
 * docs/testing-v2/gateway-cost-feasibility.md). Tier-1 injects a FAKE that
 * reproduces the OBSERVABLE contract (streamed stdout/stderr, exit-code →
 * verdict, timeout, cancellation) WITHOUT spawning an OS process.
 *
 * SAFETY (D4 "every seam defaults to real"): the default is the real durable
 * implementation, byte-for-byte the previous spawn behaviour. The fake lives
 * ONLY under tests2/ and is reachable ONLY when a test fixture explicitly
 * injects it via GatewayDeps.commandStepRunner. Production (`cli.ts`) passes no
 * runner, so `realVerificationCommandRunner` is always used there. The fake
 * never fabricates a verdict for the durable path — a runner that cannot
 * support durable recovery declares `nonDurable`, and the harness then routes
 * the step through the attached, restart→pending/retryable path (never the
 * detached pid/exit-file wrapper), so no durable machinery runs against a fake.
 */
import { spawnTracked, type TrackedChild } from "./spawn-tree.js";
import type { Clock } from "../gateway-deps.js";
import type { StdioOptions } from "node:child_process";

/**
 * Everything `runCommandStep` needs to launch one host (non-container) command
 * step. Container (docker exec) steps are intentionally NOT routed through this
 * seam — tier-1 never uses containers, and keeping the docker branch on the
 * direct `spawnTracked` call limits the seam's blast radius on a delicate file.
 */
export interface VerificationCommandSpawnSpec {
	/** Resolved shell binary (bash / Git-Bash / cmd.exe) from getVerificationShell. */
	readonly shellBin: string;
	/** Shell args (e.g. ["-c"] / ["/d","/s","/c"]). */
	readonly shellArgs: readonly string[];
	/**
	 * The command line actually handed to the shell. In detached mode this is
	 * the pid/exit-file wrapper; in attached mode it is the raw command. The
	 * real runner executes this verbatim. Fakes should prefer `command`.
	 */
	readonly cmdToRun: string;
	/** The LOGICAL command (unwrapped) — what a fake scripts its result from. */
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly stdio: StdioOptions;
	readonly windowsHide: boolean;
	/** True when the harness selected the durable detached wrapper for cmdToRun. */
	readonly useDetached: boolean;
}

export interface VerificationCommandRunner {
	/**
	 * When true, this runner cannot support the durable detached-shell recovery
	 * path (pid/exit-file wrapper + cross-restart resume). The harness forces
	 * such runners onto the attached, non-durable path so a mid-verification
	 * restart yields a pending/retryable step — never a fabricated verdict, and
	 * never a call into the durable file machinery. The real runner omits this
	 * (durable per platform).
	 */
	readonly nonDurable?: boolean;
	/** Launch one host command step; returns a TrackedChild (tree-killable). */
	spawn(spec: VerificationCommandSpawnSpec, opts?: { clock?: Clock }): TrackedChild;
}

/**
 * Default, production runner: the exact `spawnTracked` call the harness used
 * before this seam existed. No behavioural change — the durable detached wrapper
 * (built by the harness into `cmdToRun`) and the attached path both run through
 * a real OS shell exactly as before.
 */
export const realVerificationCommandRunner: VerificationCommandRunner = {
	spawn(spec) {
		return spawnTracked(spec.shellBin, [...spec.shellArgs, spec.cmdToRun], {
			cwd: spec.cwd,
			stdio: spec.stdio,
			timeoutMs: spec.timeoutMs,
			windowsHide: spec.windowsHide,
		});
	},
};

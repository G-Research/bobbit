/**
 * BUG: The "belt-and-braces" docker-exec timeout handler in
 *      `verification-harness.ts::runCommandStep` fires
 *
 *        kill -TERM -1 2>/dev/null || true; sleep 0.2; kill -KILL -1 2>/dev/null || true
 *
 *      INSIDE the project's sandbox container. `kill -SIG -1` signals
 *      every process the caller can signal (everything in the container's
 *      PID namespace except init).
 *
 * Why this matters
 * ----------------
 * The sandbox container is **per-project, not per-step**:
 *
 *   `SandboxManager` keeps `Map<projectId, ProjectSandbox>`
 *   `ProjectSandbox.getContainerId()` returns the same id for every caller.
 *
 * Inside that single container, concurrently:
 *
 *   - Up to 4 verification command steps run at a time (see
 *     `commandSemaphore = new Semaphore(4)` in verification-harness.ts).
 *   - All agent sessions for that project do their work via `docker exec`
 *     into the SAME container (see `rpc-bridge.ts::spawnDockerExec` and
 *     `bg-process-manager.ts` host-fallback). Worktree fs ops likewise
 *     go through `docker exec` (`session-fs.ts`).
 *
 * So `kill -SIG -1` from one step's timeout will signal:
 *   - every other concurrent verification command step in the project
 *   - every running agent reviewer/QA child inside that container
 *   - every bg-process and `session-fs` exec in flight
 *
 * — all of which run as the same UID, so the kernel permits the kill.
 *
 * The intent of the line — kill the in-container descendants of THIS
 * step's `docker exec` shell, because host-side tree-kill of the `docker
 * exec` cannot reach in-container descendants — is correct. The blast
 * radius is wrong: it must be scoped to the step's process subtree
 * (e.g. `setsid` + capture the in-container pid, then `kill -- -<pid>`),
 * not `-1`.
 *
 * Why this is a pinning regex test
 * --------------------------------
 * Demonstrating the blast radius end-to-end needs a real Docker daemon
 * (see `tests/manual-integration/`). The over-broad pattern is
 * unambiguous in source — once the fix lands, the `-1` will be gone and
 * this test will pass. A real-docker behavioural test belongs alongside
 * the existing per-project sandbox integration tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
	path.resolve(import.meta.dirname, "..", "src/server/agent/verification-harness.ts"),
	"utf8",
);

describe("verification-harness docker-exec timeout — blast radius", () => {
	it("does NOT fire `kill … -1` inside the shared per-project container", () => {
		// `kill -TERM -1` / `kill -KILL -1` / `kill -1` — any of these inside
		// the container nukes every process the docker-exec user can signal.
		// The fix replaces them with a pgid-scoped form derived from the
		// step's in-container shell (e.g. `setsid sh -c 'echo $$; <cmd>'`
		// and then `kill -- -<pid>` on timeout).
		const overBroadKill =
			/kill\s+(?:-(?:TERM|KILL|s\s+(?:TERM|KILL))\s+)?-1\b/;

		const matches = [...SRC.matchAll(new RegExp(overBroadKill, "g"))];
		assert.strictEqual(
			matches.length, 0,
			"`runCommandStep` fires `kill … -1` inside the per-project sandbox " +
			"container. The container is shared across every concurrent step, " +
			"agent session and bg-process for the project (`SandboxManager` " +
			"keyed by projectId; `commandSemaphore = Semaphore(4)`). One " +
			"timing-out step will SIGTERM/SIGKILL every other docker-exec'd " +
			"process owned by the same UID in that container. The container-side " +
			"kill must be scoped to the step's own subtree (capture the " +
			"in-container shell pid via `setsid sh -c 'echo $$ > <pidfile>; <cmd>'` " +
			"and `kill -- -<pid>` on timeout). Matched: " +
			matches.map(m => JSON.stringify(m[0])).join(", "),
		);
	});

	it("the docker-exec onTimeout closure uses a pgid-scoped kill, not container-wide", () => {
		// Locate the onTimeout closure in the docker-exec branch and inspect it.
		const dockerExecRe = /spawnTracked\("docker",[\s\S]*?onTimeout:\s*\(\s*\)\s*=>\s*\{([\s\S]*?)^\s*\},/m;
		const m = dockerExecRe.exec(SRC);
		assert.ok(m, "could not locate docker-exec spawnTracked block — test needs updating");

		const body = m![1];
		assert.ok(
			body.includes("docker") && body.includes("exec") && body.includes("kill"),
			"sanity: onTimeout body should fire an in-container kill",
		);

		// The body should NOT contain `-1` as a pid argument to `kill`.
		// It SHOULD use a pgid-scoped form like `kill -TERM -- -$p`.
		const hasOverBroad = /kill\s+(?:-(?:TERM|KILL|s\s+(?:TERM|KILL))\s+)?-1\b/.test(body);
		assert.strictEqual(
			hasOverBroad, false,
			"docker-exec onTimeout fires container-wide `kill … -1`. Replace with " +
			"a pgid-scoped kill derived from the step's in-container shell pid:\n" +
			"  - At spawn: wrap the command as `setsid sh -c 'echo $$ > /tmp/<id>.pid; exec <cmd>'`\n" +
			"  - On timeout: `docker exec <id> sh -c 'p=$(cat /tmp/<id>.pid); kill -TERM -- -$p; sleep 0.2; kill -KILL -- -$p; rm -f /tmp/<id>.pid'`\n" +
			"This keeps the kill bounded to the step's process subtree and " +
			"leaves concurrent agent sessions / verification steps untouched.\n\n" +
			"Current onTimeout body:\n" + body,
		);
	});
});

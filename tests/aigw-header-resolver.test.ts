/**
 * Behavioural / cross-shell contract test for the `!cmd` literal we emit in
 * `models.json` for the x-opencode-session header.
 *
 * pi-coding-agent's `resolveConfigValue` runs `!cmd` via `child_process.exec`
 * (shell-interpreted on the host's default shell — sh on POSIX, cmd.exe on
 * Windows) and:
 *   - returns trimmed stdout, or
 *   - returns undefined when stdout is empty (header is then dropped).
 *
 * This test runs the literal command directly via `child_process.exec` on
 * three env conditions and asserts stdout matches the expected behaviour
 * regardless of host shell.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

// The literal we write to models.json (after the leading "!" is stripped by
// pi's resolver before exec):
const COMMAND = `node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;

function runWithEnv(env: NodeJS.ProcessEnv): string {
	// Mirror pi-coding-agent: shell-interpreted exec.
	// execSync with default options spawns through the host shell.
	const out = execSync(COMMAND, {
		env,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return out;
}

describe("x-opencode-session resolver contract (cross-shell)", () => {
	it("BOBBIT_SESSION_ID set → stdout is the session id", () => {
		// Build a clean env without inheriting our own BOBBIT_SESSION_ID.
		const env = { ...process.env, BOBBIT_SESSION_ID: "abc123" };
		const out = runWithEnv(env);
		assert.equal(out, "abc123", "command should print the session id verbatim, no trailing newline");
	});

	it("BOBBIT_SESSION_ID unset → stdout is empty (resolver omits header)", () => {
		const env = { ...process.env };
		delete env.BOBBIT_SESSION_ID;
		const out = runWithEnv(env);
		assert.equal(out, "", "stdout must be empty when env var is unset — pi resolver drops header on empty");
	});

	it("BOBBIT_SESSION_ID empty string → stdout is empty (resolver omits header)", () => {
		const env = { ...process.env, BOBBIT_SESSION_ID: "" };
		const out = runWithEnv(env);
		assert.equal(out, "", "empty string env var must round-trip to empty stdout");
	});

	it("never emits the literal string 'BOBBIT_SESSION_ID' as output", () => {
		// Defence in depth: we want to be sure the command never falls through
		// to literal text on any shell variant. With env unset → empty.
		const env = { ...process.env };
		delete env.BOBBIT_SESSION_ID;
		const out = runWithEnv(env);
		assert.ok(!out.includes("BOBBIT_SESSION_ID"), "stdout must never contain the literal env var name (would indicate fallthrough)");
	});
});

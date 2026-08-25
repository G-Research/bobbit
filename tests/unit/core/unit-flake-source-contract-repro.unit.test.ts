// deterministic source-level regression guard for the tier-1 flake fixes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const credentialStoreTestSource = readFileSync(
	new URL("./anthropic-oauth-credential-store.unit.test.ts", import.meta.url),
	"utf8",
);
const serverSource = readFileSync(new URL("../../../src/server/server.ts", import.meta.url), "utf8");

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.ok(start >= 0, `static guard source marker missing: ${startMarker}`);
	assert.ok(end > start, `static guard source marker missing or out of order: ${endMarker}`);
	return source.slice(start, end);
}

const heldLockContention = sourceBetween(
	credentialStoreTestSource,
	'it("heartbeats a Bobbit-held lock',
	'it("does not reclaim a Pi async lock',
);
const externalLockContention = sourceBetween(
	credentialStoreTestSource,
	'it("does not reclaim a Pi async lock',
	'it("does not reclaim a replacement',
);
const sandboxStatusRoute = sourceBetween(
	serverSource,
	"// GET /api/sandbox-status",
	"// POST /api/sandbox-image/build",
);

describe("tier-1 flake source contracts", () => {
	it("uses bounded fake-time advancement after releasing a Bobbit-held lock", () => {
		assert.doesNotMatch(
			heldLockContention,
			/\bvi\.runAllTimersAsync\s*\(\s*\)/,
			"CREDENTIAL_LOCK_TIMER_CONTRACT: the Bobbit-held lock release path must advance only its bounded retry interval, never drain every fake timer.",
		);
	});

	it("uses bounded fake-time advancement after releasing a Pi async lock", () => {
		assert.doesNotMatch(
			externalLockContention,
			/\bvi\.runAllTimersAsync\s*\(\s*\)/,
			"CREDENTIAL_LOCK_TIMER_CONTRACT: the Pi async-lock release path must advance only its bounded retry interval, never drain every fake timer.",
		);
	});

	it("passes its request-scoped command runner to the sandbox-status Docker check", () => {
		assert.match(
			sandboxStatusRoute,
			/checkDockerAvailability\(\s*configured\s*\?\s*imageName\s*:\s*undefined\s*,\s*dockerContextRoot\s*\?\?\s*undefined\s*,\s*commandRunner\s*\)/,
			"SANDBOX_STATUS_RUNNER_CONTRACT: /api/sandbox-status must pass its request-scoped commandRunner to checkDockerAvailability.",
		);
		assert.doesNotMatch(
			sandboxStatusRoute,
			/\bserverCommandRunner\b/,
			"SANDBOX_STATUS_RUNNER_CONTRACT: /api/sandbox-status must not resolve Docker through the mutable server-global runner.",
		);
	});
});

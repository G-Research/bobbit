/**
 * Unit test: redactDockerArgs — docker-exec arg logging redaction.
 *
 * Regression for the HIGH finding: `rpc-bridge.ts` injects the per-session
 * capability secret BOBBIT_SESSION_SECRET into `docker exec -e` and then logs
 * the exec args via console.log. The redactor must scrub the VALUE of
 * BOBBIT_SESSION_SECRET, BOBBIT_TOKEN, and any `*_SECRET` / `*_TOKEN` env var
 * (in both `-e NAME=VALUE` and `-e NAME VALUE` forms) while keeping NAMEs and
 * non-sensitive vars (e.g. BOBBIT_SESSION_ID) visible — so the secret can never
 * leak in cleartext and be replayed as X-Bobbit-Session-Secret.
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/rpc-bridge-redact-args.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { redactDockerArgs } from "../src/server/agent/rpc-bridge.ts";

describe("redactDockerArgs", () => {
	it("redacts BOBBIT_SESSION_SECRET, BOBBIT_TOKEN, and sample *_SECRET/*_TOKEN while leaving BOBBIT_SESSION_ID visible", () => {
		const args = [
			"exec", "-i",
			"-e", "BOBBIT_SESSION_ID=sess-123",
			"-e", "BOBBIT_SESSION_SECRET=cap-secret-xyz",
			"-e", "BOBBIT_TOKEN=gw-token-abc",
			"-e", "MY_CUSTOM_SECRET=hunter2",
			"-e", "SOME_TOKEN=tok-789",
			"container-id", "node", "cli.js",
		];
		const out = redactDockerArgs(args);

		// Names stay visible
		assert.ok(out.includes("BOBBIT_SESSION_SECRET="), out);
		assert.ok(out.includes("BOBBIT_TOKEN="), out);
		assert.ok(out.includes("MY_CUSTOM_SECRET="), out);
		assert.ok(out.includes("SOME_TOKEN="), out);

		// Values are redacted
		assert.ok(!out.includes("cap-secret-xyz"), `secret leaked: ${out}`);
		assert.ok(!out.includes("gw-token-abc"), `token leaked: ${out}`);
		assert.ok(!out.includes("hunter2"), `*_SECRET leaked: ${out}`);
		assert.ok(!out.includes("tok-789"), `*_TOKEN leaked: ${out}`);
		assert.ok(out.includes("BOBBIT_SESSION_SECRET=<REDACTED>"), out);
		assert.ok(out.includes("BOBBIT_TOKEN=<REDACTED>"), out);
		assert.ok(out.includes("MY_CUSTOM_SECRET=<REDACTED>"), out);
		assert.ok(out.includes("SOME_TOKEN=<REDACTED>"), out);

		// Non-sensitive var fully visible
		assert.ok(out.includes("BOBBIT_SESSION_ID=sess-123"), out);
	});

	it("redacts the VALUE in the separated `-e NAME VALUE` form", () => {
		const args = ["-e", "BOBBIT_SESSION_SECRET", "cap-secret-split", "-e", "BOBBIT_SESSION_ID", "sess-456"];
		const out = redactDockerArgs(args);
		assert.ok(!out.includes("cap-secret-split"), `secret leaked: ${out}`);
		assert.ok(out.includes("BOBBIT_SESSION_SECRET <REDACTED>"), out);
		// Non-sensitive split var keeps its value
		assert.ok(out.includes("BOBBIT_SESSION_ID sess-456"), out);
	});

	it("does not redact values that merely contain a sensitive substring in their value", () => {
		const args = ["-e", "BOBBIT_SESSION_ID=secret-looking-but-fine"];
		const out = redactDockerArgs(args);
		// Name is not sensitive, so the value is preserved verbatim.
		assert.ok(out.includes("BOBBIT_SESSION_ID=secret-looking-but-fine"), out);
	});
});

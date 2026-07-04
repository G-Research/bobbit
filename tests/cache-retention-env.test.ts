/**
 * FINDING: CACHE-RETENTION — pi's Anthropic prompt-cache TTL defaults to a
 * 5-minute ephemeral window (pi-ai resolveCacheRetention), so Bobbit's
 * idle-then-nudged sessions (team-leads especially) re-bill the ~30-60KB
 * system+tool-docs prefix as a cache write on every wake more than 5 minutes
 * apart. `resolveCacheRetentionEnv` (src/server/agent/cache-retention.ts)
 * defaults every spawned pi-coding-agent subprocess to the 1h TTL via the
 * `PI_CACHE_RETENTION` env var pi-ai already reads natively — see
 * docs/design/cache-retention-long.md for the full seam analysis.
 *
 * This test pins two contracts:
 *
 * 1. Config plumbing: `resolveCacheRetentionEnv` defaults ON (PI_CACHE_
 *    RETENTION=long) and honors `BOBBIT_CACHE_RETENTION=short|none` as an
 *    opt-out — plus the resulting env is wired into session-setup.ts and
 *    the docker-exec sandbox path in rpc-bridge.ts at the right precedence
 *    (default first, so callers/tests can still override it).
 *
 * 2. Patch-application-style guard: the installed pi-ai 0.79.6 (hard-pinned
 *    in package.json) actually implements `resolveCacheRetention` reading
 *    `PI_CACHE_RETENTION` from the env exactly the way this feature assumes.
 *    If a future pi-ai bump changes or removes that contract, this test
 *    fails loudly instead of Bobbit silently no-op'ing the setting.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveCacheRetentionEnv } from "../src/server/agent/cache-retention.ts";

describe("cache-retention env resolution", () => {
	it("defaults to PI_CACHE_RETENTION=long when no override is set", () => {
		const env = resolveCacheRetentionEnv({});
		assert.deepEqual(env, { PI_CACHE_RETENTION: "long" });
	});

	it("opts out on BOBBIT_CACHE_RETENTION=short", () => {
		const env = resolveCacheRetentionEnv({ BOBBIT_CACHE_RETENTION: "short" });
		assert.deepEqual(env, {});
	});

	it("opts out on BOBBIT_CACHE_RETENTION=none", () => {
		const env = resolveCacheRetentionEnv({ BOBBIT_CACHE_RETENTION: "none" });
		assert.deepEqual(env, {});
	});

	it("opts out case-insensitively and trims whitespace", () => {
		assert.deepEqual(resolveCacheRetentionEnv({ BOBBIT_CACHE_RETENTION: " SHORT " }), {});
		assert.deepEqual(resolveCacheRetentionEnv({ BOBBIT_CACHE_RETENTION: "None" }), {});
	});

	it("ignores unrecognized override values and still defaults to long", () => {
		const env = resolveCacheRetentionEnv({ BOBBIT_CACHE_RETENTION: "bogus" });
		assert.deepEqual(env, { PI_CACHE_RETENTION: "long" });
	});

	it("does not mutate the passed-in env object", () => {
		const input = { BOBBIT_CACHE_RETENTION: "short" as string };
		const before = { ...input };
		resolveCacheRetentionEnv(input);
		assert.deepEqual(input, before);
	});
});

describe("cache-retention wiring into spawn paths", () => {
	it("source: session-setup.ts spreads resolveCacheRetentionEnv() as the lowest-precedence default in bridge env", () => {
		const src = readFileSync(
			path.join(process.cwd(), "src/server/agent/session-setup.ts"),
			"utf-8",
		);
		assert.ok(
			/import \{ resolveCacheRetentionEnv \} from "\.\/cache-retention\.js";/.test(src),
			"session-setup.ts must import resolveCacheRetentionEnv from cache-retention.js",
		);
		assert.ok(
			/env:\s*\{\s*\.\.\.resolveCacheRetentionEnv\(\),\s*\.\.\.plan\.env,\s*BOBBIT_SESSION_ID:\s*plan\.id,/.test(src),
			"resolveCacheRetentionEnv() must be spread first (lowest precedence) so caller env and gateway identity keys can still override it",
		);
	});

	it("source: rpc-bridge.ts forwards PI_CACHE_RETENTION into the docker-exec sandbox path", () => {
		const src = readFileSync(
			path.join(process.cwd(), "src/server/agent/rpc-bridge.ts"),
			"utf-8",
		);
		assert.ok(
			/this\.options\.env\?\.PI_CACHE_RETENTION[\s\S]{0,120}execArgs\.push\("-e", `PI_CACHE_RETENTION=\$\{this\.options\.env\.PI_CACHE_RETENTION\}`\)/.test(src),
			"spawnDockerExec must forward PI_CACHE_RETENTION via docker exec -e, same as BOBBIT_SESSION_ID/BOBBIT_GOAL_ID",
		);
	});

	it("source: model-completion.ts's one-shot cacheRetention:\"none\" override is untouched (explicit param beats env var in pi-ai)", () => {
		const src = readFileSync(
			path.join(process.cwd(), "src/server/agent/model-completion.ts"),
			"utf-8",
		);
		assert.ok(
			/cacheRetention:\s*"none"/.test(src),
			"one-shot utility completions must keep their explicit cacheRetention:\"none\" override",
		);
	});
});

describe("pi-ai 0.79.6 native PI_CACHE_RETENTION contract (patch-application-style guard)", () => {
	it("installed pi-ai reads PI_CACHE_RETENTION from env and treats \"long\" as the 1h-eligible retention tier", () => {
		const anthropicProviderPath = path.join(
			process.cwd(),
			"node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js",
		);
		const src = readFileSync(anthropicProviderPath, "utf-8");

		// resolveCacheRetention(cacheRetention, env): explicit param wins, else env var, else "short".
		assert.ok(
			/function resolveCacheRetention\(cacheRetention, env\)/.test(src),
			"pi-ai must still expose resolveCacheRetention(cacheRetention, env) with this exact signature",
		);
		assert.ok(
			/if \(cacheRetention\) \{\s*return cacheRetention;\s*\}/.test(src),
			"an explicit cacheRetention param must still take precedence over the env var (protects model-completion.ts's cacheRetention:\"none\")",
		);
		assert.ok(
			/getProviderEnvValue\("PI_CACHE_RETENTION", env\) === "long"/.test(src),
			"pi-ai must still read PI_CACHE_RETENTION from the environment and treat \"long\" as the opt-in value",
		);
		// getCacheControl: "long" retention maps to a 1h ttl (model-support-gated).
		assert.ok(
			/retention === "long" && getAnthropicCompat\(model\)\.supportsLongCacheRetention \? "1h" : undefined/.test(src),
			"pi-ai must still map retention \"long\" + model support to a 1h cache_control ttl",
		);

		// Confirm the exact pinned dependency version this contract was verified against.
		const pkg = JSON.parse(
			readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
		) as { dependencies?: Record<string, string> };
		assert.equal(
			pkg.dependencies?.["@earendil-works/pi-coding-agent"],
			"0.79.6",
			"this contract was verified against pi-coding-agent 0.79.6 — re-verify node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js before bumping the pin (see docs/design/cache-retention-long.md)",
		);
	});
});

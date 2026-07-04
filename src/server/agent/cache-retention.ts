/**
 * Anthropic prompt-cache retention for spawned pi-coding-agent sessions.
 *
 * pi-ai's Anthropic provider defaults every request to the 5-minute ("short")
 * ephemeral cache TTL and re-reads it from the `PI_CACHE_RETENTION` env var
 * on the spawned process (node_modules/@earendil-works/pi-ai/dist/providers/
 * anthropic.js:13-24, `resolveCacheRetention` — "Defaults to 'short' and uses
 * PI_CACHE_RETENTION for backward compatibility"). Setting it to `"long"`
 * switches the ephemeral cache_control blocks pi-ai attaches to the system
 * prompt / tool defs / last user message (anthropic.js:666-943) to a 1-hour
 * TTL (only for models where `getAnthropicCompat(model).supportsLongCacheRetention`
 * is true — pi-ai itself no-ops the TTL otherwise, so this is safe to set
 * unconditionally).
 *
 * Why default ON: Bobbit's core team-lead pattern is spawn → end turn → go
 * idle → wake on notification (defaults/roles/team-lead.yaml), and inter-turn
 * gaps routinely exceed 5 minutes. Under the default TTL the ~30-60KB
 * system+tool-docs prefix (see docs/design/cache-retention-long.md for the
 * full seam analysis) expires between turns and gets re-billed as a fresh
 * cache write on every wake. A 1h TTL keeps it warm across ordinary idle
 * waits.
 *
 * Tradeoff (why this is opt-out, not silently mandatory): a 1h-retention
 * cache WRITE costs ~2x a 5-min write on Anthropic's pricing (charged once,
 * on the turn that (re)establishes the cache) — the win only materializes
 * once a session takes more than ~2 turns/hour. Set
 * `BOBBIT_CACHE_RETENTION=short` (or `"none"`) to opt back into pi's default
 * short TTL, e.g. to A/B against the `cacheWrite1h` usage field pi-ai already
 * computes (anthropic.js:352) — see docs/design/cache-retention-long.md for
 * caveats on what Bobbit currently persists from that field.
 *
 * Precedence (highest to lowest):
 *   1. `BOBBIT_CACHE_RETENTION` — Bobbit's own knob. `short`/`none` map to an
 *      explicit `PI_CACHE_RETENTION=short` (pi-ai's env var only recognizes
 *      `"long"`, so anything else yields pi's short default — there is no
 *      env-level "none"; that tier only exists as an explicit per-request
 *      param, e.g. model-completion.ts). `long` forces long. Unrecognized
 *      values are ignored and fall through.
 *   2. An operator-set `PI_CACHE_RETENTION` already present in the gateway's
 *      environment — propagated through verbatim, never clobbered by the
 *      Bobbit default. Propagation is EXPLICIT (returned in the map) rather
 *      than relying on child-process env inheritance, because the docker-exec
 *      sandbox path does not inherit the gateway's process.env — it only
 *      forwards allowlisted vars from RpcBridgeOptions.env (rpc-bridge.ts
 *      spawnDockerExec).
 *   3. Bobbit's default: `long`.
 *
 * Every branch returns an explicit `PI_CACHE_RETENTION` so both spawn paths
 * (direct node spawn with env inheritance, and docker exec without) behave
 * identically. Caller-supplied per-session env (`plan.env`) is spread AFTER
 * this map in session-setup.ts and still overrides all of the above.
 *
 * Scope: this only sets an env var on the spawned pi-coding-agent subprocess
 * (via RpcBridgeOptions.env, consumed in rpc-bridge.ts); it never touches
 * pi's installed files (contrast pi-ai-bedrock-headers-patch.ts, which is a
 * genuine monkeypatch for a seam pi doesn't expose natively — retention has
 * a native seam, so no patch is needed here). Existing explicit
 * `cacheRetention` call sites (e.g. model-completion.ts's one-shot
 * `cacheRetention: "none"` utility completions) are unaffected: pi-ai's
 * `resolveCacheRetention` always prefers an explicit param over the env var.
 */
export function resolveCacheRetentionEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const override = env.BOBBIT_CACHE_RETENTION?.trim().toLowerCase();
	// 1. Bobbit's own knob wins over everything (incl. inherited PI_CACHE_RETENTION).
	if (override === "short" || override === "none") return { PI_CACHE_RETENTION: "short" };
	if (override === "long") return { PI_CACHE_RETENTION: "long" };
	// 2. An operator-set PI_CACHE_RETENTION in the gateway env flows through verbatim.
	const inherited = env.PI_CACHE_RETENTION?.trim();
	if (inherited) return { PI_CACHE_RETENTION: inherited };
	// 3. Bobbit's default.
	return { PI_CACHE_RETENTION: "long" };
}

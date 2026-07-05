/**
 * SPIKE PROTOTYPE — eligibility check for the in-process pi bridge.
 *
 * Split out of in-process-bridge.ts so `createSessionBridge`
 * (session-runtime.ts) can import it unconditionally and cheaply: this file
 * has zero dependency on `@earendil-works/pi-coding-agent`, so checking
 * eligibility never pulls the pi SDK's module graph into the gateway's
 * static import graph. Only `LazyInProcessBridge.load()` in
 * session-runtime.ts dynamically `import()`s in-process-bridge.ts (and with
 * it, the pi SDK) — and only once a session both has the flag on AND
 * actually starts. See docs/design/in-process-bridge-spike.md.
 *
 * ELIGIBILITY-SIGNAL FIX (docs/design/in-process-bridge-spike.md "Sizing
 * results (2026-07-05)"): read-only-ness used to come ONLY from the caller-
 * supplied `readOnly` flag, which just one call site in the repo ever set
 * (the PR-walkthrough reviewer launch) — the much higher-volume
 * `verification-harness.ts` gate-verify reviewer fan-out never set it, so
 * the eligible population was ~0% of that volume. `readOnly` is now ORed
 * with `isReadOnlyToolPolicy(allowedTools)` (`read-only-tool-policy.ts`,
 * also dependency-free), which derives the same signal from the session's
 * RESOLVED tool allowlist. Both directions are safe: a session can be
 * eligible via the explicit flag alone (derived=false, flag=true — e.g. the
 * PR-walkthrough reviewer's own contract), via the derived signal alone
 * (flag never set, tools happen to be read-only), or both. Never the AND —
 * that would make the one call site that already opts in today newly
 * ineligible depending on unrelated tool-list bookkeeping, a silent
 * regression.
 */
import type { RpcBridgeOptions } from "./rpc-bridge.js";
import { isReadOnlyToolPolicy } from "./read-only-tool-policy.js";

/**
 * Decide whether a session is eligible for the in-process bridge.
 *
 * The env check runs first so this function — and therefore
 * `createSessionBridge` — is a true no-op when the flag is unset, no matter
 * what the caller's options look like.
 *
 * Eligible ONLY for sessions that are read-only (by explicit `readOnly` flag
 * OR by derivation from `allowedTools` — see the header comment above), not
 * `sandboxed`, and not bound to a Docker `containerId`. Code-executing agents
 * (bash/edit/write) MUST stay out-of-process — see the design doc's
 * "Downside / risk" section for why (no sandbox containment in-process).
 */
export function isInProcessBridgeEligible(options: RpcBridgeOptions): boolean {
	if (process.env.BOBBIT_INPROC_BRIDGE !== "1") return false;
	if (options.sandboxed || options.containerId) return false;
	const readOnly = options.readOnly || isReadOnlyToolPolicy(options.allowedTools);
	if (!readOnly) return false;
	return true;
}

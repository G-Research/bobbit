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
 */
import type { RpcBridgeOptions } from "./rpc-bridge.js";

/**
 * Decide whether a session is eligible for the in-process bridge.
 *
 * The env check runs first so this function — and therefore
 * `createSessionBridge` — is a true no-op when the flag is unset, no matter
 * what the caller's options look like.
 *
 * Eligible ONLY for sessions that are `readOnly`, not `sandboxed`, and not
 * bound to a Docker `containerId`. Code-executing agents (bash/edit/write)
 * MUST stay out-of-process — see the design doc's "Downside / risk" section
 * for why (no sandbox containment in-process).
 */
export function isInProcessBridgeEligible(options: RpcBridgeOptions): boolean {
	if (process.env.BOBBIT_INPROC_BRIDGE !== "1") return false;
	if (options.sandboxed || options.containerId) return false;
	if (!options.readOnly) return false;
	return true;
}

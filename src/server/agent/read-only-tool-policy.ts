/**
 * Shared derivation: is a session's RESOLVED tool allowlist read-only (no
 * local filesystem write, no arbitrary shell exec, no image-file write)?
 *
 * BACKGROUND (docs/design/in-process-bridge-spike.md, "Sizing results
 * (2026-07-05)" section; TRACKER "eligibility-signal" item): the in-process
 * bridge's eligibility check required an opt-in `readOnly` flag that only
 * ONE call site in the repo ever set (`market-packs/pr-walkthrough/lib/
 * routes.mjs`'s reviewer launch). The much higher-volume
 * `verification-harness.ts` gate-verify reviewer fan-out never set it, so
 * the eligible population was ~0% of that volume even though several roles
 * are read-only-shaped by tool policy. This module fixes the root cause:
 * derive the classification from the session's ACTUAL resolved tool
 * allowlist instead of requiring every caller to remember an opt-in flag.
 *
 * Two independent consumers derive session class from this exact deny-set
 * so they cannot silently drift apart:
 *   - `in-process-bridge-eligibility.ts` — the in-process pi bridge has no
 *     Docker/child-process containment, so it is only safe for a session
 *     whose resolved tools cannot touch the host filesystem or run
 *     arbitrary commands (see the design doc's "Loss of the Docker sandbox"
 *     risk — "Do not relax the eligibility check to include ... any bash/
 *     edit/write allowlist without solving this first").
 *   - `orchestration-core.ts`'s `childAllowedTools` re-exports
 *     `MUTATING_TOOLS` as `READ_ONLY_DENY_TOOLS` (its established,
 *     pre-existing name) so a `readOnly` child never has a mutating tool
 *     REGISTERED in the first place.
 *
 * NOT the same axis as `session-manager.ts`'s `isNarrowDelegateAllowedTools`
 * (F22 "narrow worker" criterion): narrowness is an ALLOW-list of
 * coding-task-shaped tools that deliberately INCLUDES `write`/`edit`/`bash`
 * (a narrow delegate is still allowed to mutate files — it's just proven to
 * be scoped to a single bounded task). Read-only-ness here is the opposite:
 * a DENY-set that excludes any mutating tool. The two lists cannot share one
 * constant without contorting one of them; see the cross-reference comment
 * next to `NARROW_WORKER_TOOLS` in session-manager.ts.
 *
 * Deliberately dependency-free (no pi SDK, no ToolManager, no session
 * types) so both consumers — including the in-process-bridge eligibility
 * check, which must stay cheap and pi-SDK-free — can import it for free.
 */

/**
 * Tools that mutate the local filesystem or execute arbitrary host
 * commands, sourced from the actual tool inventory
 * (`defaults/tools/**\/*.yaml`): `write`/`edit` (File System — overwrite or
 * patch a file), `bash`/`bash_bg` (Shell — UNPOLICED command execution; a
 * command-policed variant like PR-walkthrough's `readonly_bash` is a
 * different tool name and is intentionally NOT in this set), `generate_image`
 * (Images — writes an image file to disk). This is exactly the bar the
 * design doc's `createReadOnlyTools()` reference point implies: no exec, no
 * mutation.
 *
 * Verified empirically (2026-07-05) against every built-in "reviewer-shaped"
 * role (`reviewer`, `code-reviewer`, `security-reviewer`, `spec-auditor`,
 * `bug-hunter`, `architect`) via `computeEffectiveAllowedTools`: none of
 * them deny `bash` or `write` (only `edit`/`bash_bg`/`team_delegate`/
 * goal-mutation tools are denied), so each resolves to a ~52-tool surface
 * that DOES include `bash`+`write` — i.e. none of them are read-only under
 * this deny-set today. That's a real, more accurate finding than PR #157's
 * static-grep census (which only checked for explicit `never` entries and
 * missed that `bash`/`write` default-allow at the group level per
 * `defaults/tool-group-policies.yaml`). This module's job is to classify
 * correctly from the resolved list, not to change what those roles grant.
 */
export const MUTATING_TOOLS: readonly string[] = ["write", "edit", "bash", "bash_bg", "generate_image"];

/**
 * True for any MCP tool name — either the wire form (`mcp__<server>...`) or
 * the collapsed meta-tool form (`mcp_<server>...`; see `mcpPolicyKeys` in
 * tool-activation.ts for the two shapes). MCP tools are per-installation,
 * dynamically named, and can wrap arbitrary server-side operations — Bobbit
 * has no static classification for them, so they can never be proven
 * read-only here.
 */
function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__") || name.startsWith("mcp_");
}

/**
 * Derive read-only-ness from a session's RESOLVED tool allowlist (e.g.
 * `plan.effectiveAllowedTools`/`session.allowedTools` — the actual grant set
 * after role/group/project policy resolution, NOT a role's raw
 * `toolPolicies` object, which may leave many tools unlisted and therefore
 * default-allowed).
 *
 * - `undefined` (unrestricted — no allowlist was resolved, the session
 *   inherits the full tool catalogue) fails closed: an unrestricted session
 *   always has `write`/`bash` available, so it can never be read-only.
 * - `[]` (an explicit, resolved empty allowlist) is vacuously read-only:
 *   there is no tool available to mutate anything with.
 * - Any tool in `MUTATING_TOOLS`, or any MCP tool name (fail-closed —
 *   unrecognized/dynamic), makes the whole list NOT read-only.
 */
export function isReadOnlyToolPolicy(allowedTools: readonly string[] | undefined): boolean {
	if (allowedTools === undefined) return false;
	for (const raw of allowedTools) {
		const name = raw.toLowerCase();
		if (MUTATING_TOOLS.includes(name)) return false;
		if (isMcpToolName(name)) return false;
	}
	return true;
}

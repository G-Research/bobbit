/**
 * Pure helper for building the `PUT /api/projects/:id/config` payload from a
 * project-proposal fields bag.
 *
 * Used by both `acceptProvisionalProjectProposal()` (first-time accept of a
 * freshly-discovered project) and `acceptRegisteredProjectProposal()`
 * (mid-session edits to an already-registered project) in
 * `src/app/session-manager.ts`. Keeping the logic here means:
 *
 *   - No browser-only deps so it can be unit-tested with node:test.
 *   - Both accept paths agree on which fields ride through to the server,
 *     preventing the regression where provisional accept silently dropped
 *     `components` / `workflows` and a multi-component project landed with
 *     zero workflows.
 */

/** Best-effort JSON.parse used to coerce string-shaped `components`/`workflows`
 *  fields back into structured form when the agent supplied them as strings. */
export function safeParseJson(text: string): unknown {
	try { return JSON.parse(text); } catch { return undefined; }
}

/** Native-YAML / structured fields on `project.yaml`. The server's
 *  `PUT /api/projects/:id/config` rejects JSON-string payloads for these
 *  keys — callers must send structured types. `components` and `workflows`
 *  are included so an accepted project carries the assistant's proposed
 *  structure end-to-end.
 *
 *  Note: the seven legacy top-level `qa_*` keys (`qa_env`,
 *  `qa_max_duration_minutes`, `qa_max_scenarios`, etc.) are intentionally
 *  excluded — the server rejects them at the top level entirely now
 *  (HTTP 400 with a migration message). QA settings live inside
 *  `components[].config` and ride through via the `components` payload. */
export const PROJECT_NATIVE_FIELDS: ReadonlySet<string> = new Set([
	"config_directories", "sandbox_tokens",
	"components", "workflows",
]);

/** Legacy top-level `qa_*` keys that have moved to `components[].config`.
 *  The server rejects them at the top level with HTTP 400. Filter them out
 *  client-side so an older agent that still emits them at the top level
 *  doesn't make Apply Changes fail. */
const REJECTED_LEGACY_QA_TOP_LEVEL: ReadonlySet<string> = new Set([
	"qa_start_command", "qa_build_command", "qa_health_check",
	"qa_browser_entry", "qa_env",
	"qa_max_duration_minutes", "qa_max_scenarios",
]);

/** Build the `PUT /api/projects/:id/config` payload from a project-proposal
 *  fields bag.
 *
 *  - `name` and `root_path` are skipped (handled separately / immutable).
 *  - Legacy top-level `qa_*` keys are dropped (rejected by the server).
 *  - Empty / null / undefined values are dropped.
 *  - Native-YAML fields are kept structured; if the agent supplied them as a
 *    JSON string, they are parsed back to objects/arrays.
 *  - All other fields are forwarded as-is. */
export function buildProjectConfigDiff(fields: Record<string, unknown>): Record<string, unknown> {
	const diff: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields)) {
		if (k === "name" || k === "root_path") continue;
		if (REJECTED_LEGACY_QA_TOP_LEVEL.has(k)) continue;
		if (v === undefined || v === null || v === "") continue;
		if (PROJECT_NATIVE_FIELDS.has(k)) {
			diff[k] = typeof v === "string" ? safeParseJson(v) ?? v : v;
		} else {
			diff[k] = v;
		}
	}
	return diff;
}

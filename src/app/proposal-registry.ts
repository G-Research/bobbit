/**
 * Client-side proposal-type registry. The single plugin point that
 * Slice E will hang the per-type bespoke side-effects, validation,
 * accept handlers, and renderer hookups off.
 *
 * In Slice D this file ships:
 *   - the `ProposalType` union
 *   - the `ProposalSlot` interface (mirror of server's TypedProposal projection)
 *   - the `ProposalTypePlugin` interface
 *   - a `PROPOSAL_TYPE_REGISTRY` table whose `mergeFields` is filled in
 *     for all six types (the only piece needed before the cutover so
 *     `RemoteAgent.onProposal` can fold streaming partials correctly)
 *
 * `onFirstEmit`, `validate`, `accept`, `renderPanel` are intentionally
 * stubbed with a TODO. Slice E will populate them by lifting the
 * existing per-type logic verbatim from `session-manager.ts` /
 * `render.ts`. Do NOT delete the legacy onXProposal callbacks until
 * Slice E swaps the call sites — see Slice D scope notes.
 */

export type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

export const PROPOSAL_TYPES: readonly ProposalType[] = ["goal", "project", "workflow", "role", "tool", "staff"];

/**
 * In-memory projection of a proposal for the active session. Mirrors the
 * server's `proposal_update` payload shape (see `src/server/ws/protocol.ts`).
 *
 * `mode` is project-only (provisional vs registered); other types leave it
 * undefined.
 *
 * `rev` increments on every merge. Slice E uses it to gate one-shot
 * side-effects (`onFirstEmit`) — `prev == null` is the canonical first-emit
 * predicate, but `rev` also gives renderers a cheap reactivity key.
 */
export interface ProposalSlot {
	sessionId: string;
	fields: Record<string, unknown>;
	streaming: boolean;
	mode?: "provisional" | "registered";
	rev: number;
}

export interface ProposalFirstEmitOpts {
	isAssistant: boolean;
	isMobile: boolean;
}

export interface ProposalTypePlugin {
	type: ProposalType;
	/**
	 * Merge an incoming (possibly partial) field bag into the prior projection.
	 * For most types this is a plain `{ ...prev, ...incoming }`. Two carry-forwards:
	 *   - project: keep prior `components` / `workflows` when the incoming partial
	 *     omits them (lifted from session-manager.ts::onProjectProposal Bug-C fix).
	 *   - goal: keep prior `spec` body when incoming partial only updates frontmatter
	 *     (so a streaming frontmatter partial doesn't blank the spec mid-stream).
	 */
	mergeFields(prev: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown>;

	// ---- Slice E will fill these in ----
	/** Auto-select the right tab on the very first emit per session. */
	onFirstEmit(slot: ProposalSlot, opts: ProposalFirstEmitOpts): void;
	/** Synchronous structural validation for the accept button. Returns error messages. */
	validate(fields: Record<string, unknown>): string[];
	/** Submit the proposal. Routes per-type to the right REST endpoint. */
	accept(slot: ProposalSlot): Promise<void>;
	/** Bespoke per-type panel renderer. Slice E will plumb the actual templates through. */
	renderPanel(): unknown;
}

/** Default mergeFields = plain object spread. role/tool/staff/workflow use this. */
function defaultMerge(
	prev: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	return { ...prev, ...incoming };
}

/** Project carries forward `components` / `workflows` when the incoming partial omits them. */
function projectMerge(
	prev: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...prev, ...incoming };
	if (!("components" in incoming) && "components" in prev) merged.components = prev.components;
	if (!("workflows" in incoming) && "workflows" in prev) merged.workflows = prev.workflows;
	return merged;
}

/** Goal preserves `spec` body across frontmatter-only partials. */
function goalMerge(
	prev: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...prev, ...incoming };
	// If the incoming partial has no `spec` key (or has an empty-string spec
	// while we already have a non-empty one), preserve the prior spec.
	if (!("spec" in incoming) && "spec" in prev) {
		merged.spec = prev.spec;
	} else if (
		"spec" in incoming &&
		(incoming.spec === "" || incoming.spec == null) &&
		typeof prev.spec === "string" &&
		prev.spec.length > 0
	) {
		merged.spec = prev.spec;
	}
	return merged;
}

// ---- Stubs for Slice E ----
// Each stub throws / no-ops so a misordered cutover surfaces immediately
// instead of silently dropping behaviour.

function todoFirstEmit(_slot: ProposalSlot, _opts: ProposalFirstEmitOpts): void {
	// TODO(slice-e): lift per-type onFirstEmit body from session-manager.ts.
	// goal:    state.previewPanelActiveTab = "goal"; mobile flips previewPanelTab="goal".
	// project: state.previewPanelActiveTab = "project"; mobile flips previewPanelTab="project".
	// role/tool/staff/workflow: state.assistantTab = "preview" when assistant session; etc.
}

function todoValidate(_fields: Record<string, unknown>): string[] {
	// TODO(slice-e): lift per-type structural validation from existing accept handlers.
	return [];
}

async function todoAccept(_slot: ProposalSlot): Promise<void> {
	// TODO(slice-e): lift per-type accept body from session-manager.ts
	// (createGoal / acceptProjectProposal / role+staff accept endpoints / workflow PUT / tool PUT).
	throw new Error("ProposalTypePlugin.accept is not yet wired (Slice E).");
}

function todoRenderPanel(): unknown {
	// TODO(slice-e): wire to existing bespoke panel renderers in render.ts
	// (goalPreviewPanel, projectProposalPanel, rolePreviewPanel, etc.).
	return undefined;
}

function makePlugin(type: ProposalType, mergeFields: ProposalTypePlugin["mergeFields"]): ProposalTypePlugin {
	return {
		type,
		mergeFields,
		onFirstEmit: todoFirstEmit,
		validate: todoValidate,
		accept: todoAccept,
		renderPanel: todoRenderPanel,
	};
}

export const PROPOSAL_TYPE_REGISTRY: Record<ProposalType, ProposalTypePlugin> = {
	goal: makePlugin("goal", goalMerge),
	project: makePlugin("project", projectMerge),
	workflow: makePlugin("workflow", defaultMerge),
	role: makePlugin("role", defaultMerge),
	tool: makePlugin("tool", defaultMerge),
	staff: makePlugin("staff", defaultMerge),
};

/** Type guard for narrowing arbitrary strings to `ProposalType`. */
export function isProposalType(s: unknown): s is ProposalType {
	return typeof s === "string" && (PROPOSAL_TYPES as readonly string[]).includes(s);
}

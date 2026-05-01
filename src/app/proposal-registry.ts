/**
 * Client-side proposal-type registry. The single plugin point that
 * Slice E hangs the per-type bespoke side-effects, validation,
 * accept handlers, and renderer hookups off.
 *
 * For accept handlers: per design Slice E retains the existing per-type
 * accept paths at their original call sites (createGoal, acceptProjectProposal,
 * role/staff/tool/workflow accept endpoints, workflow PUT). The plugin's
 * `accept` hook is reserved for future consolidation. `renderPanel` is
 * unused for Slice E and reserved for future work.
 */

// NOTE: We do NOT import `./state.js` at module load — state.ts touches
// `localStorage` at module init which would break node-only unit tests of
// the registry's pure mergeFields helpers. The onFirstEmit hooks lazy-import
// the state object via a getter that's threaded through at call time. See
// `getStateForFirstEmit` below.

export type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

export const PROPOSAL_TYPES: readonly ProposalType[] = ["goal", "project", "workflow", "role", "tool", "staff"];

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
	mergeFields(prev: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown>;
	onFirstEmit(slot: ProposalSlot, opts: ProposalFirstEmitOpts): void;
	validate(fields: Record<string, unknown>): string[];
	accept(slot: ProposalSlot): Promise<void>;
	renderPanel(): unknown;
}

function defaultMerge(
	prev: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	return { ...prev, ...incoming };
}

function projectMerge(
	prev: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...prev, ...incoming };
	if (!("components" in incoming) && "components" in prev) merged.components = prev.components;
	if (!("workflows" in incoming) && "workflows" in prev) merged.workflows = prev.workflows;
	return merged;
}

function goalMerge(
	prev: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...prev, ...incoming };
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

// ---- onFirstEmit lifters ----

function clearCollapseKey(sessionId: string): void {
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.removeItem(`bobbit-preview-collapsed-${sessionId}`);
		}
	} catch { /* ignore */ }
}

/** Lazily resolve the mutable state singleton at call time so this module's
 *  load-time graph stays node-safe. */
function getState(): any {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return (globalThis as any).bobbitState ?? {};
}

function goalFirstEmit(slot: ProposalSlot, opts: ProposalFirstEmitOpts): void {
	const s = getState();
	if (opts.isAssistant) {
		s.assistantHasProposal = true;
		if (s.assistantTab === "chat" && opts.isMobile) {
			s.assistantTab = "preview";
		}
	} else {
		s.previewPanelActiveTab = "goal";
		clearCollapseKey(slot.sessionId);
		if (opts.isMobile) s.previewPanelTab = "goal";
	}
}

function projectFirstEmit(slot: ProposalSlot, opts: ProposalFirstEmitOpts): void {
	const s = getState();
	if (opts.isAssistant) {
		s.assistantHasProposal = true;
		if (s.assistantTab === "chat" && opts.isMobile) {
			s.assistantTab = "preview";
		}
	} else {
		s.previewPanelActiveTab = "project";
		clearCollapseKey(slot.sessionId);
		if (opts.isMobile) s.previewPanelTab = "project";
	}
}

function assistantOnlyFirstEmit(_slot: ProposalSlot, opts: ProposalFirstEmitOpts): void {
	const s = getState();
	s.assistantHasProposal = true;
	if (s.assistantTab === "chat" && opts.isMobile) {
		s.assistantTab = "preview";
	}
}

// ---- validators ----

function requireKeys(fields: Record<string, unknown>, keys: string[]): string[] {
	const errs: string[] = [];
	for (const k of keys) {
		const v = fields[k];
		if (typeof v !== "string" || v.trim() === "") {
			errs.push(`${k} is required`);
		}
	}
	return errs;
}

function goalValidate(fields: Record<string, unknown>): string[] {
	return requireKeys(fields, ["title", "spec"]);
}

function projectValidate(fields: Record<string, unknown>): string[] {
	return requireKeys(fields, ["name", "root_path"]);
}

function roleValidate(fields: Record<string, unknown>): string[] {
	return requireKeys(fields, ["name", "label", "prompt"]);
}

function staffValidate(fields: Record<string, unknown>): string[] {
	return requireKeys(fields, ["name", "prompt"]);
}

function toolValidate(fields: Record<string, unknown>): string[] {
	return requireKeys(fields, ["tool", "action", "content"]);
}

function workflowValidate(fields: Record<string, unknown>): string[] {
	return requireKeys(fields, ["id", "name"]);
}

async function todoAccept(_slot: ProposalSlot): Promise<void> {
	throw new Error("Slice E: per-type accept handlers retained at original sites");
}

function todoRenderPanel(): unknown {
	return undefined;
}

interface PluginConfig {
	mergeFields: ProposalTypePlugin["mergeFields"];
	onFirstEmit: ProposalTypePlugin["onFirstEmit"];
	validate: ProposalTypePlugin["validate"];
}

function makePlugin(type: ProposalType, cfg: PluginConfig): ProposalTypePlugin {
	return {
		type,
		mergeFields: cfg.mergeFields,
		onFirstEmit: cfg.onFirstEmit,
		validate: cfg.validate,
		accept: todoAccept,
		renderPanel: todoRenderPanel,
	};
}

export const PROPOSAL_TYPE_REGISTRY: Record<ProposalType, ProposalTypePlugin> = {
	goal: makePlugin("goal", { mergeFields: goalMerge, onFirstEmit: goalFirstEmit, validate: goalValidate }),
	project: makePlugin("project", { mergeFields: projectMerge, onFirstEmit: projectFirstEmit, validate: projectValidate }),
	workflow: makePlugin("workflow", { mergeFields: defaultMerge, onFirstEmit: assistantOnlyFirstEmit, validate: workflowValidate }),
	role: makePlugin("role", { mergeFields: defaultMerge, onFirstEmit: assistantOnlyFirstEmit, validate: roleValidate }),
	tool: makePlugin("tool", { mergeFields: defaultMerge, onFirstEmit: assistantOnlyFirstEmit, validate: toolValidate }),
	staff: makePlugin("staff", { mergeFields: defaultMerge, onFirstEmit: assistantOnlyFirstEmit, validate: staffValidate }),
};

export function isProposalType(s: unknown): s is ProposalType {
	return typeof s === "string" && (PROPOSAL_TYPES as readonly string[]).includes(s);
}


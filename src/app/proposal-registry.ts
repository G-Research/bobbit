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

import { proposalPanelTabId } from "./panel-workspace.js";

// NOTE: We do NOT import `./state.js` at module load — state.ts touches
// `localStorage` at module init which would break node-only unit tests of
// the registry's pure mergeFields helpers. The onFirstEmit hooks lazy-import
// the state object via a getter that's threaded through at call time. See
// `getStateForFirstEmit` below.

export type ProposalType = "goal" | "project" | "role" | "tool" | "staff";

export const PROPOSAL_TYPES: readonly ProposalType[] = ["goal", "project", "role", "tool", "staff"];

function assistantProposalTypeFromState(stateLike: any): ProposalType | null {
	const raw = typeof stateLike?.assistantType === "string" ? stateLike.assistantType : "";
	if (raw === "project-scaffolding") return "project";
	return isProposalType(raw) ? raw : null;
}

export function hasCurrentProposalSlotForSession(stateLike: any, type: string, sessionId: string): type is ProposalType {
	if (!isProposalType(type)) return false;
	const slot = stateLike?.activeProposals?.[type];
	if (slot) {
		const slotSessionId = typeof slot.sessionId === "string" ? slot.sessionId : "";
		return !sessionId || !slotSessionId || slotSessionId === sessionId;
	}

	// Legacy assistant surfaces may have form-mirror proposal state before the
	// typed slot table is populated. Do not use this fallback once other typed
	// slots exist, or a delayed async upsert can resurrect a dismissed tab.
	const activeProposals = stateLike?.activeProposals;
	const hasTypedSlots = !!activeProposals && typeof activeProposals === "object" && Object.keys(activeProposals).length > 0;
	return !hasTypedSlots && stateLike?.assistantHasProposal === true && assistantProposalTypeFromState(stateLike) === type;
}

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
	// Per-component shallow merge: when both prev and incoming carry
	// `components`, merge entries by name so a partial component update
	// (e.g. only `commands`) doesn't clobber the previously-proposed
	// `config` (or vice versa) on that component.
	if (Array.isArray(incoming.components) && Array.isArray(prev.components)) {
		const prevComps = prev.components as Array<Record<string, unknown>>;
		const prevByName = new Map<string, Record<string, unknown>>();
		for (const pc of prevComps) {
			if (pc && typeof pc === "object" && typeof pc.name === "string") prevByName.set(pc.name, pc);
		}
		merged.components = (incoming.components as Array<Record<string, unknown>>).map(c => {
			if (!c || typeof c !== "object" || typeof c.name !== "string") return c;
			const prevC = prevByName.get(c.name);
			if (!prevC) return c;
			return {
				...prevC,
				...c,
				commands: c.commands ?? prevC.commands,
				config: c.config ?? prevC.config,
			};
		});
	}
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

/** Lazily resolve the mutable state singleton at call time so this module's
 *  load-time graph stays node-safe. */
function getState(): any {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return (globalThis as any).bobbitState ?? {};
}

const PROPOSAL_TAB_LABELS: Record<ProposalType, string> = {
	goal: "Goal Proposal",
	project: "Project Proposal",
	role: "Role Proposal",
	tool: "Tool Proposal",
	staff: "Staff Proposal",
};

function dropCurrentProposalWorkspaceTab(type: ProposalType, sessionId: string): void {
	const id = proposalPanelTabId(type);
	void import("./side-panel-workspace.js")
		.then((mod) => mod.closeSidePanelTab(id, { sessionId }))
		.catch(() => { /* optional browser-only integration */ });
}

function openCurrentProposalWorkspaceTab(type: ProposalType, sessionId: string): boolean {
	const s = getState();
	if (!hasCurrentProposalSlotForSession(s, type, sessionId)) {
		dropCurrentProposalWorkspaceTab(type, sessionId);
		return false;
	}
	const tab = {
		id: proposalPanelTabId(type),
		kind: "proposal" as const,
		title: PROPOSAL_TAB_LABELS[type],
		label: PROPOSAL_TAB_LABELS[type].replace(/ Proposal$/, ""),
		source: { type: "proposal" as const, proposalType: type, sessionId },
		updatedAt: Date.now(),
	};
	void import("./side-panel-workspace.js")
		.then((mod) => mod.openSidePanelTab(tab, { focus: true }))
		.catch(() => { /* optional browser-only integration */ });
	try {
		if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
			window.dispatchEvent(new CustomEvent("bobbit-panel-workspace:select", { detail: { action: "select", tab, activeTabId: tab.id } }));
		}
	} catch { /* ignore */ }
	return true;
}

function selectProposalWorkspaceTab(type: ProposalType, sessionId: string, setAssistantTab: boolean): void {
	if (!openCurrentProposalWorkspaceTab(type, sessionId)) return;
	const s = getState();
	if (setAssistantTab && s.assistantType) s.assistantTab = "preview";
}

/**
 * Reveal the UI surface for a proposal slot. Assistant sessions keep legacy
 * mobile `assistantTab` compatibility while also selecting the typed proposal
 * tab for the dynamic workspace.
 */
export function revealProposalPanel(type: ProposalType, slot: Pick<ProposalSlot, "sessionId">, opts: ProposalFirstEmitOpts): void {
	const s = getState();
	if (opts.isAssistant) {
		s.assistantHasProposal = true;
		if (s.assistantTab === "chat" && opts.isMobile) {
			s.assistantTab = "preview";
		}
	}

	s.previewPanelActiveTab = type;
	s.previewPanelTab = type;
	selectProposalWorkspaceTab(type, slot.sessionId, !opts.isAssistant || opts.isMobile);
}

function proposalFirstEmit(type: ProposalType): ProposalTypePlugin["onFirstEmit"] {
	return (slot, opts) => revealProposalPanel(type, slot, opts);
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
	goal: makePlugin("goal", { mergeFields: goalMerge, onFirstEmit: proposalFirstEmit("goal"), validate: goalValidate }),
	project: makePlugin("project", { mergeFields: projectMerge, onFirstEmit: proposalFirstEmit("project"), validate: projectValidate }),
	role: makePlugin("role", { mergeFields: defaultMerge, onFirstEmit: proposalFirstEmit("role"), validate: roleValidate }),
	tool: makePlugin("tool", { mergeFields: defaultMerge, onFirstEmit: proposalFirstEmit("tool"), validate: toolValidate }),
	staff: makePlugin("staff", { mergeFields: defaultMerge, onFirstEmit: proposalFirstEmit("staff"), validate: staffValidate }),
};

export function isProposalType(s: unknown): s is ProposalType {
	return typeof s === "string" && (PROPOSAL_TYPES as readonly string[]).includes(s);
}


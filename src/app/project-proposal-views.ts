/**
 * Pure render helpers for the project proposal panel.
 *
 * These functions produce Lit `TemplateResult`s from structured proposal
 * payloads. They are read-only views: edits to components / workflows happen
 * by asking the assistant to revise.
 *
 * Local interfaces mirror `SeededWorkflow` / `SeededGate` / `SeededVerifyStep`
 * from `src/server/state-migration/seed-default-workflows.ts`. We duplicate
 * them here intentionally so this module has no cross-module type coupling
 * with server-side code.
 */
import { html, type TemplateResult } from "lit";

// ---------------------------------------------------------------------------
// Local types — kept structural so they're assignable to/from server seeds.
// ---------------------------------------------------------------------------

export interface ProposalComponent {
	name: string;
	repo?: string;
	relative_path?: string;
	worktree_setup_command?: string;
	commands?: Record<string, string>;
}

export interface ProposalVerifyStep {
	name?: string;
	type?: "command" | "llm-review" | "agent-qa" | string;
	component?: string;
	command?: string;
	run?: string;
	role?: string;
	prompt?: string;
	phase?: number;
	timeout?: number;
	expect?: "success" | "failure" | string;
	optional?: boolean;
	label?: string;
	description?: string;
	[key: string]: unknown;
}

export interface ProposalGate {
	id: string;
	name?: string;
	description?: string;
	depends_on?: string[];
	content?: boolean;
	inject_downstream?: boolean;
	metadata?: Record<string, string>;
	verify?: ProposalVerifyStep[];
}

export interface ProposalWorkflow {
	id: string;
	name?: string;
	description?: string;
	gates: ProposalGate[];
}

export type ViewMode = "components" | "workflows" | "diff";

// ---------------------------------------------------------------------------
// Tab nav
// ---------------------------------------------------------------------------

export function viewTabs(active: ViewMode, onChange: (m: ViewMode) => void, hasDiff: boolean): TemplateResult {
	const tab = (mode: ViewMode, label: string, enabled = true) => {
		const isActive = active === mode;
		const cls = [
			"px-3 py-1.5 text-xs font-medium border-b-2 transition-colors select-none",
			isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
			enabled ? "cursor-pointer" : "opacity-40 cursor-not-allowed",
		].join(" ");
		return html`
			<button
				type="button"
				data-testid="view-tab-${mode}"
				class=${cls}
				?disabled=${!enabled}
				@click=${() => { if (enabled) onChange(mode); }}
			>${label}</button>
		`;
	};
	return html`
		<div class="flex gap-1 px-5 border-b border-border shrink-0" role="tablist">
			${tab("components", "Components")}
			${tab("workflows", "Workflows")}
			${tab("diff", "Diff", hasDiff)}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// Components view
// ---------------------------------------------------------------------------

export function componentsView(components: ProposalComponent[]): TemplateResult {
	if (!components || components.length === 0) {
		return html`<div class="text-sm text-muted-foreground italic">No components proposed.</div>`;
	}
	return html`
		<div class="flex flex-col gap-3">
			${components.map(c => componentCard(c))}
		</div>
	`;
}

function componentCard(c: ProposalComponent): TemplateResult {
	const cmds = c.commands ? Object.entries(c.commands) : [];
	const dataOnly = cmds.length === 0;
	const componentId = `comp-${c.name}`;
	return html`
		<div
			id=${componentId}
			data-testid="component-card-${c.name}"
			class="rounded-md border border-border bg-card p-3 flex flex-col gap-2"
		>
			<div class="flex items-center gap-2">
				<span class="font-medium text-sm">${c.name}</span>
				${dataOnly
					? html`<span class="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground" data-testid="data-only-badge">data-only</span>`
					: html`<span class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">${cmds.length} cmd${cmds.length === 1 ? "" : "s"}</span>`
				}
			</div>
			${c.repo ? html`<div class="text-xs text-muted-foreground font-mono">repo: ${c.repo}</div>` : ""}
			${c.relative_path ? html`<div class="text-xs text-muted-foreground font-mono">path: ${c.relative_path}</div>` : ""}
			${cmds.length > 0 ? html`
				<div class="flex flex-wrap gap-1">
					${cmds.map(([name, cmd]) => html`
						<span
							id=${`comp-cmd-${c.name}-${name}`}
							class="text-[11px] px-1.5 py-0.5 rounded bg-secondary font-mono"
							title=${cmd}
						>${name}</span>
					`)}
				</div>
			` : ""}
			${c.worktree_setup_command ? html`
				<details class="mt-1">
					<summary class="text-[11px] text-muted-foreground cursor-pointer select-none">worktree setup</summary>
					<pre class="text-[11px] mt-1 p-2 rounded bg-secondary/40 overflow-x-auto"><code>${c.worktree_setup_command}</code></pre>
				</details>
			` : ""}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// Workflows view
// ---------------------------------------------------------------------------

export function workflowsView(
	workflows: Record<string, ProposalWorkflow>,
	components: ProposalComponent[],
): TemplateResult {
	const ids = Object.keys(workflows);
	if (ids.length === 0) {
		return html`<div class="text-sm text-muted-foreground italic">No workflows proposed.</div>`;
	}
	const componentNames = new Set(components.map(c => c.name));
	return html`
		<div class="flex flex-col gap-3">
			${ids.map(id => workflowCard(id, workflows[id], componentNames))}
		</div>
	`;
}

function workflowCard(id: string, wf: ProposalWorkflow, componentNames: Set<string>): TemplateResult {
	const gates = wf.gates ?? [];
	const stepCount = gates.reduce((acc, g) => acc + (g.verify?.length ?? 0), 0);
	return html`
		<details
			open
			data-testid="workflow-card-${id}"
			class="rounded-md border border-border bg-card"
		>
			<summary class="px-3 py-2 cursor-pointer select-none flex items-center gap-2">
				<span class="font-medium text-sm">${wf.name ?? id}</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">${gates.length} gate${gates.length === 1 ? "" : "s"}</span>
				<span class="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">${stepCount} step${stepCount === 1 ? "" : "s"}</span>
			</summary>
			${wf.description ? html`<div class="px-3 pb-2 text-xs text-muted-foreground">${wf.description}</div>` : ""}
			<div class="px-3 pb-3">${gateList(gates, componentNames)}</div>
		</details>
	`;
}

/** Topological-sort gates into rows. Each row contains gates with all upstream deps already in earlier rows. */
function topoRows(gates: ProposalGate[]): ProposalGate[][] {
	const remaining = new Map<string, ProposalGate>();
	for (const g of gates) remaining.set(g.id, g);
	const placed = new Set<string>();
	const rows: ProposalGate[][] = [];
	let safety = gates.length + 1;
	while (remaining.size > 0 && safety-- > 0) {
		const row: ProposalGate[] = [];
		for (const g of remaining.values()) {
			const deps = g.depends_on ?? [];
			if (deps.every(d => placed.has(d) || !remaining.has(d) && !gates.some(x => x.id === d) || placed.has(d))) {
				row.push(g);
			}
		}
		if (row.length === 0) {
			// Cycle / unresolved — flush remainder.
			row.push(...remaining.values());
		}
		for (const g of row) {
			remaining.delete(g.id);
			placed.add(g.id);
		}
		rows.push(row);
	}
	return rows;
}

function gateList(gates: ProposalGate[], componentNames: Set<string>): TemplateResult {
	const rows = topoRows(gates);
	return html`
		<div class="flex flex-col gap-2">
			${rows.map((row, rowIdx) => html`
				<div class="flex flex-col gap-2" data-row-index=${rowIdx}>
					${row.map(g => gateNode(g, componentNames))}
				</div>
			`)}
		</div>
	`;
}

function gateNode(g: ProposalGate, componentNames: Set<string>): TemplateResult {
	const deps = g.depends_on ?? [];
	const steps = g.verify ?? [];
	return html`
		<div
			data-testid="gate-node-${g.id}"
			data-gate-id=${g.id}
			class="rounded border border-border bg-secondary/20 p-2 flex flex-col gap-1"
		>
			<div class="flex items-center gap-2 flex-wrap">
				<span class="font-medium text-xs">${g.name ?? g.id}</span>
				<span class="text-[10px] font-mono text-muted-foreground">${g.id}</span>
				${g.content ? html`<span class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">content</span>` : ""}
				${deps.length > 0 ? html`<span class="text-[10px] text-muted-foreground">↑ depends on ${deps.join(", ")}</span>` : ""}
			</div>
			${g.description ? html`<div class="text-[11px] text-muted-foreground italic">${g.description}</div>` : ""}
			${steps.length > 0 ? html`
				<ul class="flex flex-col gap-1 mt-1">
					${steps.map(s => html`<li>${stepBadge(s, componentNames)}</li>`)}
				</ul>
			` : ""}
		</div>
	`;
}

function stepBadge(step: ProposalVerifyStep, componentNames: Set<string>): TemplateResult {
	const type = step.type ?? "command";
	const phase = typeof step.phase === "number" ? step.phase : null;
	const isFailure = step.expect === "failure";
	const colorClass = type === "llm-review"
		? "bg-purple-500/15 text-purple-700 dark:text-purple-300"
		: type === "agent-qa"
		? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
		: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";

	let body: TemplateResult | string = "";
	if (type === "command") {
		if (step.component && step.command) {
			const known = componentNames.has(step.component);
			body = html`<span
				class=${`text-[11px] font-mono ${known ? "underline decoration-dotted cursor-pointer" : ""}`}
				data-link-comp=${step.component}
				@click=${() => {
					if (!known) return;
					const el = document.getElementById(`comp-${step.component}`);
					el?.scrollIntoView({ behavior: "smooth", block: "center" });
				}}
			>${step.component} → ${step.command}</span>`;
		} else if (step.run) {
			body = html`<code class="text-[11px] font-mono">${step.run}</code>`;
		} else {
			body = html`<span class="text-[11px] text-muted-foreground italic">(no command)</span>`;
		}
	} else if (type === "llm-review") {
		const promptPreview = (step.prompt ?? "").slice(0, 60);
		body = html`
			<span class="text-[11px]">
				${step.role ? html`<span class="font-mono">${step.role}</span>` : ""}
				${promptPreview ? html`<span class="text-muted-foreground"> — ${promptPreview}${(step.prompt ?? "").length > 60 ? "…" : ""}</span>` : ""}
			</span>`;
	} else if (type === "agent-qa") {
		body = html`<span class="text-[11px]">${step.optional ? "opt-in" : ""}</span>`;
	}

	return html`
		<span class="inline-flex items-center gap-1.5 flex-wrap">
			<span
				data-testid="step-badge-${type}"
				class=${`text-[10px] px-1.5 py-0.5 rounded ${colorClass} font-medium`}
			>${type}</span>
			${phase != null ? html`<span class="text-[10px] text-muted-foreground">phase ${phase}</span>` : ""}
			${isFailure ? html`<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-300 font-medium">must fail</span>` : ""}
			<span class="text-[11px]">${step.name ?? ""}</span>
			${body}
		</span>
	`;
}

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------

interface ComponentDiff {
	added: ProposalComponent[];
	removed: ProposalComponent[];
	changed: { name: string; before: ProposalComponent; after: ProposalComponent }[];
}

interface WorkflowDiffEntry {
	id: string;
	addedGates: string[];
	removedGates: string[];
	changedGates: string[];
}

interface WorkflowDiff {
	added: string[];
	removed: string[];
	changed: WorkflowDiffEntry[];
}

function diffComponents(prev: ProposalComponent[], cur: ProposalComponent[]): ComponentDiff {
	const prevByName = new Map(prev.map(c => [c.name, c]));
	const curByName = new Map(cur.map(c => [c.name, c]));
	const added: ProposalComponent[] = [];
	const removed: ProposalComponent[] = [];
	const changed: { name: string; before: ProposalComponent; after: ProposalComponent }[] = [];
	for (const c of cur) {
		if (!prevByName.has(c.name)) added.push(c);
		else if (JSON.stringify(prevByName.get(c.name)) !== JSON.stringify(c)) {
			changed.push({ name: c.name, before: prevByName.get(c.name)!, after: c });
		}
	}
	for (const c of prev) if (!curByName.has(c.name)) removed.push(c);
	return { added, removed, changed };
}

function diffWorkflows(prev: Record<string, ProposalWorkflow>, cur: Record<string, ProposalWorkflow>): WorkflowDiff {
	const prevIds = new Set(Object.keys(prev));
	const curIds = new Set(Object.keys(cur));
	const added: string[] = [];
	const removed: string[] = [];
	const changed: WorkflowDiffEntry[] = [];
	for (const id of curIds) {
		if (!prevIds.has(id)) added.push(id);
		else {
			const p = prev[id];
			const c = cur[id];
			if (JSON.stringify(p) !== JSON.stringify(c)) {
				const prevGates = new Map((p.gates ?? []).map(g => [g.id, g]));
				const curGates = new Map((c.gates ?? []).map(g => [g.id, g]));
				const addedGates: string[] = [];
				const removedGates: string[] = [];
				const changedGates: string[] = [];
				for (const [gid, g] of curGates) {
					if (!prevGates.has(gid)) addedGates.push(gid);
					else if (JSON.stringify(prevGates.get(gid)) !== JSON.stringify(g)) changedGates.push(gid);
				}
				for (const gid of prevGates.keys()) if (!curGates.has(gid)) removedGates.push(gid);
				changed.push({ id, addedGates, removedGates, changedGates });
			}
		}
	}
	for (const id of prevIds) if (!curIds.has(id)) removed.push(id);
	return { added, removed, changed };
}

export function diffView(
	previous: { components: ProposalComponent[]; workflows: Record<string, ProposalWorkflow> } | null,
	current: { components: ProposalComponent[]; workflows: Record<string, ProposalWorkflow> },
): TemplateResult {
	if (!previous) {
		return html`<div class="text-sm text-muted-foreground italic" data-testid="diff-empty">No diff (first proposal).</div>`;
	}
	const cd = diffComponents(previous.components, current.components);
	const wd = diffWorkflows(previous.workflows, current.workflows);

	return html`
		<div class="flex flex-col gap-4">
			<section data-testid="diff-components-section" class="flex flex-col gap-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Components
					<span class="ml-2 font-normal">
						<span class="text-emerald-600">+${cd.added.length}</span>
						<span class="text-amber-600 ml-1">~${cd.changed.length}</span>
						<span class="text-red-600 ml-1">-${cd.removed.length}</span>
					</span>
				</h3>
				${cd.added.length === 0 && cd.changed.length === 0 && cd.removed.length === 0
					? html`<div class="text-xs text-muted-foreground italic">No component changes.</div>`
					: html`
						${cd.added.map(c => html`<div data-testid="diff-component-added" class="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-800 dark:text-emerald-300">+ ${c.name}</div>`)}
						${cd.changed.map(c => html`<div data-testid="diff-component-changed" class="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-800 dark:text-amber-300">~ ${c.name}</div>`)}
						${cd.removed.map(c => html`<div data-testid="diff-component-removed" class="text-xs px-2 py-1 rounded bg-red-500/10 text-red-800 dark:text-red-300">- ${c.name}</div>`)}
					`}
			</section>

			<section data-testid="diff-workflows-section" class="flex flex-col gap-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Workflows
					<span class="ml-2 font-normal">
						<span class="text-emerald-600">+${wd.added.length}</span>
						<span class="text-amber-600 ml-1">~${wd.changed.length}</span>
						<span class="text-red-600 ml-1">-${wd.removed.length}</span>
					</span>
				</h3>
				${wd.added.length === 0 && wd.changed.length === 0 && wd.removed.length === 0
					? html`<div class="text-xs text-muted-foreground italic">No workflow changes.</div>`
					: html`
						${wd.added.map(id => html`<div data-testid="diff-workflow-added" class="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-800 dark:text-emerald-300">+ ${id}</div>`)}
						${wd.changed.map(entry => html`
							<details data-testid="diff-workflow-changed" class="text-xs rounded bg-amber-500/10 text-amber-800 dark:text-amber-300">
								<summary class="px-2 py-1 cursor-pointer select-none">~ ${entry.id}</summary>
								<div class="px-3 py-1 flex flex-col gap-0.5">
									${entry.addedGates.map(g => html`<div>+ gate ${g}</div>`)}
									${entry.changedGates.map(g => html`<div>~ gate ${g}</div>`)}
									${entry.removedGates.map(g => html`<div>- gate ${g}</div>`)}
								</div>
							</details>
						`)}
						${wd.removed.map(id => html`<div data-testid="diff-workflow-removed" class="text-xs px-2 py-1 rounded bg-red-500/10 text-red-800 dark:text-red-300">- ${id}</div>`)}
					`}
			</section>
		</div>
	`;
}

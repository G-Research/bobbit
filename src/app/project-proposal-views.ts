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
	/** Opaque per-component key→string map (consumed by skills like /qa-test). Read-only in this view. */
	config?: Record<string, string>;
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

export type ViewMode = "components" | "workflows" | "settings";

// ---------------------------------------------------------------------------
// Tab nav
// ---------------------------------------------------------------------------

export interface ViewTabCounts {
	components?: number;
	workflows?: number;
}

export function viewTabs(
	active: ViewMode,
	onChange: (m: ViewMode) => void,
	counts: ViewTabCounts = {},
): TemplateResult {
	const tab = (mode: ViewMode, label: string, count: number | undefined, enabled = true) => {
		const isActive = active === mode;
		const cls = [
			"flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium border-b-2 transition-colors select-none whitespace-nowrap",
			isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
			enabled ? "cursor-pointer" : "opacity-40 cursor-not-allowed",
		].join(" ");
		const badgeCls = isActive
			? "text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
			: "text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium";
		return html`
			<button
				type="button"
				data-testid="view-tab-${mode}"
				class=${cls}
				?disabled=${!enabled}
				@click=${() => { if (enabled) onChange(mode); }}
			>
				<span>${label}</span>
				${typeof count === "number" ? html`<span class=${badgeCls} data-testid="view-tab-count-${mode}">${count}</span>` : ""}
			</button>
		`;
	};
	return html`
		<div class="flex border-b border-border shrink-0 overflow-x-auto" role="tablist">
			${tab("components", "Components", counts.components)}
			${tab("workflows", "Workflows", counts.workflows)}
			${tab("settings", "Settings", undefined)}
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
		<div class="wf-list">
			${components.map(c => componentRow(c))}
		</div>
	`;
}

function componentRow(c: ProposalComponent): TemplateResult {
	const cmds = c.commands ? Object.entries(c.commands) : [];
	const cfgEntries = c.config ? Object.entries(c.config) : [];
	const dataOnly = cmds.length === 0;
	const componentId = `comp-${c.name}`;
	// Path summary in the collapsed row: omit `.` (uninformative for single-repo).
	const summaryParts: string[] = [];
	if (c.repo && c.repo !== ".") summaryParts.push(c.repo);
	if (c.relative_path) summaryParts.push(c.relative_path);
	const pathSummary = summaryParts.join(" / ");
	return html`
		<details
			id=${componentId}
			data-testid="component-card-${c.name}"
			class="wf-proposal-workflow"
		>
			<summary class="wf-row" style="list-style:none;">
				<div class="wf-row-info">
					<span class="wf-row-name">${c.name}</span>
					${pathSummary ? html`<span class="wf-row-desc" style="font-family:var(--font-mono,monospace);">${pathSummary}</span>` : ""}
				</div>
				<div class="wf-row-badges">
					${dataOnly
						? html`<span class="wf-badge" data-testid="data-only-badge">data-only</span>`
						: html`<span class="wf-badge">${cmds.length} cmd${cmds.length === 1 ? "" : "s"}</span>`
					}
					${c.worktree_setup_command ? html`<span class="wf-badge">setup</span>` : ""}
					${cfgEntries.length > 0 ? html`<span class="wf-badge">${cfgEntries.length} cfg</span>` : ""}
				</div>
			</summary>
			<div class="wf-proposal-gates">
				<div class="wf-gate-card" style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;">
					${c.repo ? html`
						<div class="flex items-baseline gap-2">
							<span class="text-[11px] text-muted-foreground" style="min-width:110px;">Git repo</span>
							<span class="text-[12px] font-mono">${c.repo === "." ? html`<span class="text-muted-foreground">. (project root)</span>` : c.repo}</span>
						</div>
					` : ""}
					${c.relative_path ? html`
						<div class="flex items-baseline gap-2">
							<span class="text-[11px] text-muted-foreground" style="min-width:110px;">Component path</span>
							<span class="text-[12px] font-mono">${c.relative_path}</span>
						</div>
					` : ""}
					${cmds.length > 0 ? html`
						<div>
							<div class="text-[11px] text-muted-foreground mb-1.5">Commands</div>
							<div class="flex flex-col gap-1.5">
								${cmds.map(([name, cmd]) => html`
									<div class="flex items-baseline gap-2" id=${`comp-cmd-${c.name}-${name}`}>
										<span class="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium font-mono" style="min-width:60px;text-align:center;flex-shrink:0;">${name}</span>
										<code class="text-[12px] font-mono break-all">${cmd}</code>
									</div>
								`)}
							</div>
						</div>
					` : ""}
					${c.worktree_setup_command ? html`
						<div>
							<div class="text-[11px] text-muted-foreground mb-1.5">Worktree setup</div>
							<pre class="text-[11px] m-0 p-2 rounded bg-secondary/40 overflow-x-auto"><code>${c.worktree_setup_command}</code></pre>
						</div>
					` : ""}
					<div data-testid="component-config-${c.name}">
						<div class="text-[11px] text-muted-foreground mb-1.5">Config</div>
						${cfgEntries.length === 0
							? html`<div class="text-[11px] text-muted-foreground italic" data-testid="component-config-empty-${c.name}">No config entries</div>`
							: html`
								<div class="flex flex-col gap-1.5">
									${cfgEntries.map(([k, v]) => html`
										<div class="flex items-baseline gap-2" data-testid="component-config-row-${c.name}-${k}">
											<code class="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium font-mono" style="flex-shrink:0;">${k}</code>
											<span class="text-[12px] font-mono break-all">${v}</span>
										</div>
									`)}
								</div>
							`}
					</div>
				</div>
			</div>
		</details>
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
		<div class="wf-list">
			${ids.map(id => workflowRow(id, workflows[id], componentNames))}
		</div>
	`;
}

function workflowRow(id: string, wf: ProposalWorkflow, componentNames: Set<string>): TemplateResult {
	const gates = wf.gates ?? [];
	const stepCount = gates.reduce((acc, g) => acc + (g.verify?.length ?? 0), 0);
	return html`
		<details data-testid="workflow-card-${id}" class="wf-proposal-workflow">
			<summary class="wf-row" style="list-style:none;">
				<div class="wf-row-info">
					<span class="wf-row-name">${wf.name ?? id}</span>
					${wf.description ? html`<span class="wf-row-desc">${wf.description}</span>` : ""}
				</div>
				<div class="wf-row-badges">
					<span class="wf-badge">${gates.length} gate${gates.length === 1 ? "" : "s"}</span>
					<span class="wf-badge">${stepCount} step${stepCount === 1 ? "" : "s"}</span>
				</div>
			</summary>
			<div class="wf-proposal-gates">${gateList(gates, componentNames)}</div>
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
	let idx = 0;
	return html`
		<div class="flex flex-col gap-2">
			${rows.map((row, rowIdx) => html`
				<div class="flex flex-col gap-2" data-row-index=${rowIdx}>
					${row.map(g => gateNode(g, componentNames, idx++))}
				</div>
			`)}
		</div>
	`;
}

function gateNode(g: ProposalGate, componentNames: Set<string>, idx: number): TemplateResult {
	const deps = g.depends_on ?? [];
	const steps = g.verify ?? [];
	// Group verify steps by phase (default 0), preserving insertion order within each phase.
	const byPhase = new Map<number, ProposalVerifyStep[]>();
	for (const s of steps) {
		const p = typeof s.phase === "number" ? s.phase : 0;
		if (!byPhase.has(p)) byPhase.set(p, []);
		byPhase.get(p)!.push(s);
	}
	const phases = Array.from(byPhase.keys()).sort((a, b) => a - b);
	return html`
		<details
			data-testid="gate-node-${g.id}"
			data-gate-id=${g.id}
			class="wf-gate-card"
		>
			<summary class="wf-gate-header" style="list-style:none;cursor:pointer;">
				<span class="wf-gate-idx">${idx + 1}</span>
				<span class="wf-gate-chevron">▸</span>
				<span class="wf-gate-name">${g.name ?? g.id}</span>
				${g.content ? html`<span class="wf-gate-pill">content</span>` : ""}
				${deps.length > 0 ? html`<span class="wf-gate-pill">← ${deps.join(", ")}</span>` : ""}
				${steps.length > 0 ? html`<span class="wf-gate-pill">${steps.length} step${steps.length === 1 ? "" : "s"}</span>` : ""}
			</summary>
			<div class="wf-gate-body">
				<div class="wf-gate-body-inner">
					<div class="text-[11px] font-mono text-muted-foreground">${g.id}</div>
					${g.description ? html`<div class="text-[12px] text-muted-foreground">${g.description}</div>` : ""}
					${steps.length > 0 ? html`
						<div class="flex flex-col gap-2">
							${phases.map(phase => html`
								<div class="wf-phase-group">
									<div class="wf-phase-header"><span>Phase ${phase}</span></div>
									<div class="wf-phase-body">
										${(byPhase.get(phase) ?? []).map(s => stepCard(s, componentNames))}
									</div>
								</div>
							`)}
						</div>
					` : ""}
				</div>
			</div>
		</details>
	`;
}

function stepCard(step: ProposalVerifyStep, componentNames: Set<string>): TemplateResult {
	const type = step.type ?? "command";
	const isFailure = step.expect === "failure";
	return html`
		<details class="wf-vstep-card">
			<summary class="wf-vstep-collapsed-header" style="list-style:none;">
				<span class="wf-vstep-chevron">▸</span>
				<span class="wf-vstep-name-label">${step.name || "(unnamed)"}</span>
				<span class="wf-vstep-sep">·</span>
				<span class="wf-vstep-type-label">${type}</span>
				${step.optional ? html`<span class="wf-gate-pill">optional</span>` : ""}
				${isFailure ? html`<span class="wf-gate-pill" style="background:rgb(239 68 68 / 0.15);color:rgb(185 28 28);">must fail</span>` : ""}
				<span class="wf-vstep-spacer"></span>
			</summary>
			<div class="wf-vstep-body"><div class="wf-vstep-fields">
				${stepDetails(step, type, componentNames)}
			</div></div>
		</details>
	`;
}

function stepDetails(step: ProposalVerifyStep, type: string, componentNames: Set<string>): TemplateResult {
	if (type === "command") {
		if (step.component && step.command) {
			const known = componentNames.has(step.component);
			return html`
				<div class="text-[11px] text-muted-foreground">Component command</div>
				<div class="text-[12px] font-mono">
					<span class=${known ? "text-foreground" : "text-amber-600"}>${step.component}</span>
					<span class="text-muted-foreground"> → </span>
					<span class="text-foreground">${step.command}</span>
				</div>
				${!known ? html`<div class="text-[11px] text-amber-600">unknown component</div>` : ""}
			`;
		}
		if (step.run) {
			return html`
				<div class="text-[11px] text-muted-foreground">Inline command</div>
				<pre class="text-[11px] p-2 rounded bg-secondary/40 overflow-x-auto m-0"><code>${step.run}</code></pre>
			`;
		}
		return html`<div class="text-[11px] text-muted-foreground italic">No command configured.</div>`;
	}
	if (type === "llm-review") {
		return html`
			${step.role ? html`<div class="text-[11px]"><span class="text-muted-foreground">Role:</span> <span class="font-mono">${step.role}</span></div>` : ""}
			${step.prompt ? html`<div>
				<div class="text-[11px] text-muted-foreground mb-1">Prompt</div>
				<pre class="text-[11px] p-2 rounded bg-secondary/40 overflow-x-auto whitespace-pre-wrap m-0">${step.prompt}</pre>
			</div>` : html`<div class="text-[11px] text-muted-foreground italic">(default review prompt)</div>`}
		`;
	}
	if (type === "agent-qa") {
		return html`
			${step.role ? html`<div class="text-[11px]"><span class="text-muted-foreground">Role:</span> <span class="font-mono">${step.role}</span></div>` : ""}
			${step.label ? html`<div class="text-[11px]"><span class="text-muted-foreground">Label:</span> ${step.label}</div>` : ""}
			${step.description ? html`<div class="text-[11px] text-muted-foreground">${step.description}</div>` : ""}
		`;
	}
	return html``;
}



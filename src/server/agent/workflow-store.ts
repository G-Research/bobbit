import { YamlStore } from "./yaml-store.js";

export interface VerifyStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa";
	run?: string;
	prompt?: string;
	expect?: "success" | "failure";
	timeout?: number;
	phase?: number;
	optional?: boolean;
	label?: string;
	role?: string;
	description?: string;
}

export interface WorkflowGate {
	id: string;
	name: string;
	dependsOn: string[];
	content?: boolean;
	injectDownstream?: boolean;
	optional?: boolean;
	metadata?: Record<string, string>;
	verify?: VerifyStep[];
}

export interface Workflow {
	id: string;
	name: string;
	description: string;
	gates: WorkflowGate[];
	createdAt: number;
	updatedAt: number;
	/** If true, workflow is hidden from the UI (e.g. test-only workflows) */
	hidden?: boolean;
}

// ── Normalization helpers ────────────────────────────────────────

function normalizeGate(data: Record<string, unknown>): WorkflowGate {
	const gate: WorkflowGate = {
		id: (data.id as string) ?? "",
		name: (data.name as string) ?? "",
		dependsOn: Array.isArray(data.depends_on) ? data.depends_on
			: Array.isArray(data.dependsOn) ? data.dependsOn
			: [],
	};
	if (data.content === true) gate.content = true;
	if (data.inject_downstream === true || data.injectDownstream === true) gate.injectDownstream = true;
	if (data.optional === true) gate.optional = true;
	if (data.metadata && typeof data.metadata === "object") {
		gate.metadata = data.metadata as Record<string, string>;
	}
	if (Array.isArray(data.verify)) {
		gate.verify = (data.verify as Record<string, unknown>[]).map(normalizeVerifyStep);
	}
	return gate;
}

function normalizeVerifyStep(data: Record<string, unknown>): VerifyStep {
	const step: VerifyStep = {
		name: (data.name as string) ?? "",
		type: (data.type as "command" | "llm-review" | "agent-qa") ?? "command",
	};
	if (typeof data.run === "string") step.run = data.run;
	if (typeof data.prompt === "string") step.prompt = data.prompt;
	if (data.expect === "success" || data.expect === "failure") step.expect = data.expect;
	if (typeof data.timeout === "number") step.timeout = data.timeout;
	if (typeof data.phase === "number") step.phase = data.phase;
	if (data.optional === true) step.optional = true;
	if (typeof data.label === "string") step.label = data.label;
	if (typeof data.role === "string") step.role = data.role;
	if (typeof data.description === "string") step.description = data.description;
	return step;
}

function parseWorkflow(data: Record<string, unknown>): Workflow | null {
	if (!data.id) return null;
	const gates = Array.isArray(data.gates) ? data.gates : [];
	const wf: Workflow = {
		id: data.id as string,
		name: (data.name as string) ?? (data.id as string),
		description: (data.description as string) ?? "",
		gates: gates.map((g: Record<string, unknown>) => normalizeGate(g)),
		createdAt: (data.createdAt as number) ?? 0,
		updatedAt: (data.updatedAt as number) ?? 0,
	};
	if (data.hidden === true) wf.hidden = true;
	return wf;
}

function serializeWorkflow(workflow: Workflow): Record<string, unknown> {
	return {
		id: workflow.id,
		name: workflow.name,
		description: workflow.description,
		...(workflow.hidden ? { hidden: true } : {}),
		gates: workflow.gates.map((g) => {
			const out: Record<string, unknown> = { id: g.id, name: g.name };
			if (g.content) out.content = true;
			if (g.injectDownstream) out.inject_downstream = true;
			if (g.optional) out.optional = true;
			if (g.dependsOn && g.dependsOn.length > 0) out.depends_on = g.dependsOn;
			if (g.metadata) out.metadata = g.metadata;
			if (g.verify && g.verify.length > 0) {
				out.verify = g.verify.map(v => {
					const s: Record<string, unknown> = { name: v.name, type: v.type };
					if (v.run) s.run = v.run;
					if (v.prompt) s.prompt = v.prompt;
					if (v.expect) s.expect = v.expect;
					if (v.timeout) s.timeout = v.timeout;
					if (v.phase) s.phase = v.phase;
					if (v.optional) s.optional = v.optional;
					if (v.label) s.label = v.label;
					if (v.role) s.role = v.role;
					if (v.description) s.description = v.description;
					return s;
				});
			}
			return out;
		}),
		createdAt: workflow.createdAt,
		updatedAt: workflow.updatedAt,
	};
}

/**
 * File-backed workflow store with builtin cascade support.
 * Each workflow is a YAML file in workflows/<id>.yaml.
 * Hidden workflows (e.g. test-only) are filtered from getAll/getAllLocal.
 */
export class WorkflowStore extends YamlStore<Workflow> {
	constructor(configDir: string) {
		super(configDir, {
			subdir: "workflows",
			keyFn: w => w.id,
			parseItem: parseWorkflow,
			serializeItem: serializeWorkflow,
			logPrefix: "[workflow-store]",
			filter: w => !w.hidden,
		});
	}
}

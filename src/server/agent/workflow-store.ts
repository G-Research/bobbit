import fs from "node:fs";
import path from "node:path";
import { stringify, parse } from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";

export interface VerifyStep {
	name: string;
	type: "command" | "llm-review";
	run?: string;
	prompt?: string;
	expect?: "success" | "failure";
	timeout?: number;
}

export interface WorkflowGate {
	id: string;
	name: string;
	dependsOn: string[];
	content?: boolean;
	injectDownstream?: boolean;
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

/** workflows/ directory in .bobbit/config — version controlled */
const WORKFLOWS_DIR = path.join(bobbitConfigDir(), "workflows");

/**
 * File-backed workflow store. Each workflow is a YAML file in
 * workflows/<id>.yaml at the repo root. Version controlled —
 * edits via the UI write back to the same files so they can be committed.
 */
export class WorkflowStore {
	private workflows: Map<string, Workflow> = new Map();

	constructor() {
		fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
		this.loadAll();
		// Seed defaults if directory is empty
		if (this.workflows.size === 0) {
			this.seedDefaults();
		}
	}

	private workflowFilePath(id: string): string {
		const filePath = path.join(WORKFLOWS_DIR, `${id}.yaml`);
		const resolved = path.resolve(filePath);
		if (!resolved.startsWith(path.resolve(WORKFLOWS_DIR))) {
			throw new Error(`Invalid workflow id: path traversal detected`);
		}
		return filePath;
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(WORKFLOWS_DIR, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.id) {
					this.workflows.set(data.id, this.normalizeWorkflow(data));
				}
			} catch (err) {
				console.error(`[workflow-store] Failed to load ${filePath}:`, err);
			}
		}
	}

	private normalizeWorkflow(data: Record<string, unknown>): Workflow {
		const gates = Array.isArray(data.gates) ? data.gates : [];
		const wf: Workflow = {
			id: data.id as string,
			name: (data.name as string) ?? (data.id as string),
			description: (data.description as string) ?? "",
			gates: gates.map((g: Record<string, unknown>) => this.normalizeGate(g)),
			createdAt: (data.createdAt as number) ?? 0,
			updatedAt: (data.updatedAt as number) ?? 0,
		};
		if (data.hidden === true) wf.hidden = true;
		return wf;
	}

	private normalizeGate(data: Record<string, unknown>): WorkflowGate {
		const gate: WorkflowGate = {
			id: (data.id as string) ?? "",
			name: (data.name as string) ?? "",
			dependsOn: Array.isArray(data.depends_on) ? data.depends_on
				: Array.isArray(data.dependsOn) ? data.dependsOn
				: [],
		};
		if (data.content === true) gate.content = true;
		if (data.inject_downstream === true || data.injectDownstream === true) gate.injectDownstream = true;
		if (data.metadata && typeof data.metadata === "object") {
			gate.metadata = data.metadata as Record<string, string>;
		}
		if (Array.isArray(data.verify)) {
			gate.verify = (data.verify as Record<string, unknown>[]).map(v => this.normalizeVerifyStep(v));
		}
		return gate;
	}

	private normalizeVerifyStep(data: Record<string, unknown>): VerifyStep {
		const step: VerifyStep = {
			name: (data.name as string) ?? "",
			type: (data.type as "command" | "llm-review") ?? "command",
		};
		if (typeof data.run === "string") step.run = data.run;
		if (typeof data.prompt === "string") step.prompt = data.prompt;
		if (data.expect === "success" || data.expect === "failure") step.expect = data.expect;
		if (typeof data.timeout === "number") step.timeout = data.timeout;
		return step;
	}

	private saveOne(workflow: Workflow): void {
		const filePath = this.workflowFilePath(workflow.id);
		try {
			const obj: Record<string, unknown> = {
				id: workflow.id,
				name: workflow.name,
				description: workflow.description,
				...(workflow.hidden ? { hidden: true } : {}),
				gates: workflow.gates.map((g) => {
					const out: Record<string, unknown> = {
						id: g.id,
						name: g.name,
					};
					if (g.content) out.content = true;
					if (g.injectDownstream) out.inject_downstream = true;
					if (g.dependsOn && g.dependsOn.length > 0) out.depends_on = g.dependsOn;
					if (g.metadata) out.metadata = g.metadata;
					if (g.verify && g.verify.length > 0) {
						out.verify = g.verify.map(v => {
							const s: Record<string, unknown> = { name: v.name, type: v.type };
							if (v.run) s.run = v.run;
							if (v.prompt) s.prompt = v.prompt;
							if (v.expect) s.expect = v.expect;
							if (v.timeout) s.timeout = v.timeout;
							return s;
						});
					}
					return out;
				}),
				createdAt: workflow.createdAt,
				updatedAt: workflow.updatedAt,
			};
			const content = stringify(obj, { lineWidth: 0 });
			fs.writeFileSync(filePath, content, "utf-8");
		} catch (err) {
			console.error(`[workflow-store] Failed to save ${filePath}:`, err);
		}
	}

	private seedDefaults(): void {
		const bugFixPath = path.join(WORKFLOWS_DIR, "bug-fix.yaml");
		if (fs.existsSync(bugFixPath)) {
			this.loadAll();
		} else {
			console.warn("[workflow-store] No seed workflows found in workflows/ directory. Expected bug-fix.yaml to be committed to the repo.");
		}
	}

	put(workflow: Workflow): void {
		this.workflows.set(workflow.id, workflow);
		this.saveOne(workflow);
	}

	get(id: string): Workflow | undefined {
		return this.workflows.get(id);
	}

	remove(id: string): void {
		this.workflows.delete(id);
		const filePath = this.workflowFilePath(id);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	}

	/** Re-read all YAML files from disk, picking up external changes */
	reload(): void {
		this.workflows.clear();
		this.loadAll();
	}

	getAll(): Workflow[] {
		this.reload();
		return Array.from(this.workflows.values()).filter(w => !w.hidden);
	}

	update(id: string, updates: Partial<Omit<Workflow, "id" | "createdAt">>): boolean {
		const existing = this.workflows.get(id);
		if (!existing) return false;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined && k !== "id" && k !== "createdAt") cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.saveOne(existing);
		return true;
	}
}

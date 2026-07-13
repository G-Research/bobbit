import { WorkflowStore, type Workflow, type WorkflowGate } from "./workflow-store.js";
import type { ProjectConfigStore } from "./project-config-store.js";
import { freezeWorkflowDefinition, validateAllWorkflows, type ValidatorWorkflow, type WorkflowComponentRef } from "./workflow-validator.js";

/**
 * Workflow manager — wraps the inline store and applies the same full
 * definition validator/freeze semantics used by goal snapshots.
 */
export class WorkflowManager {
	/** Exposed for passing to createGoal for workflow snapshotting. */
	public readonly store: WorkflowStore;
	private readonly cfg?: ProjectConfigStore;

	constructor(store: WorkflowStore, cfg?: ProjectConfigStore) {
		this.store = store;
		this.cfg = cfg;
		this._logBootValidation();
	}

	private getComponentRefs(): WorkflowComponentRef[] {
		if (!this.cfg) return [];
		return this.cfg.getComponents().map(component => ({
			name: component.name,
			commands: component.commands,
		}));
	}

	private _logBootValidation(): void {
		// Tolerate mock stores in tests that don't implement getAllLocal().
		if (typeof (this.store as any)?.getAllLocal !== "function") return;
		try {
			const map: Record<string, ValidatorWorkflow> = {};
			for (const workflow of this.store.getAllLocal()) map[workflow.id] = workflow as unknown as ValidatorWorkflow;
			for (const error of validateAllWorkflows(map, this.getComponentRefs())) {
				console.warn(`[workflow-manager] ${error.message}`);
			}
		} catch (error) {
			console.warn("[workflow-manager] Boot validation skipped:", error);
		}
	}

	createWorkflow(opts: {
		id: string;
		name: string;
		description?: string;
		gates: WorkflowGate[];
	}): Workflow {
		if (this.store.getLocal(opts.id)) throw new Error(`Workflow "${opts.id}" already exists`);
		const now = Date.now();
		const workflow = freezeWorkflowDefinition({
			id: opts.id,
			name: opts.name,
			description: opts.description ?? "",
			gates: opts.gates,
			createdAt: now,
			updatedAt: now,
		}, this.getComponentRefs(), opts.id);
		this.store.put(workflow);
		return workflow;
	}

	getWorkflow(id: string): Workflow | undefined {
		return this.store.get(id);
	}

	listWorkflows(): Workflow[] {
		return this.store.getAll();
	}

	updateWorkflow(id: string, updates: {
		name?: string;
		description?: string;
		gates?: WorkflowGate[];
	}): boolean {
		const existing = this.store.get(id);
		if (!existing) return false;
		const candidate = freezeWorkflowDefinition({
			...existing,
			...updates,
			id: existing.id,
			createdAt: existing.createdAt,
			updatedAt: Date.now(),
		}, this.getComponentRefs(), id);
		return this.store.update(id, {
			name: candidate.name,
			description: candidate.description,
			gates: candidate.gates,
			updatedAt: candidate.updatedAt,
		});
	}

	deleteWorkflow(id: string): boolean {
		if (!this.store.get(id)) return false;
		this.store.remove(id);
		return true;
	}
}

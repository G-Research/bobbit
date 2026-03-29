import { WorkflowStore, type Workflow, type WorkflowGate } from "./workflow-store.js";

/** Valid workflow ID pattern: lowercase alphanumeric + hyphens */
/** Lowercase alphanumeric + hyphens only. Dots are banned to avoid collisions
 *  with the namespaced template variable syntax ({{gate_id.meta.key}}). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export class WorkflowManager {
	/** Exposed for passing to createGoal for workflow snapshotting */
	public readonly store: WorkflowStore;

	constructor(store: WorkflowStore) {
		this.store = store;
	}

	createWorkflow(opts: {
		id: string;
		name: string;
		description?: string;
		gates: WorkflowGate[];
	}): Workflow {
		const { id, name, gates } = opts;

		if (!id || typeof id !== "string") {
			throw new Error("Missing workflow id");
		}
		if (!ID_PATTERN.test(id)) {
			throw new Error("Workflow id must be lowercase alphanumeric + hyphens (e.g. 'my-workflow')");
		}
		if (this.store.get(id)) {
			throw new Error(`Workflow "${id}" already exists`);
		}
		if (!name || typeof name !== "string") {
			throw new Error("Missing workflow name");
		}

		this.validateGates(gates);

		const now = Date.now();
		const workflow: Workflow = {
			id,
			name,
			description: opts.description || "",
			gates,
			createdAt: now,
			updatedAt: now,
		};
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

		if (updates.gates) {
			this.validateGates(updates.gates);
		}

		const cleaned: Partial<Omit<Workflow, "id" | "createdAt">> = {};
		if (updates.name !== undefined) cleaned.name = updates.name;
		if (updates.description !== undefined) cleaned.description = updates.description;
		if (updates.gates !== undefined) cleaned.gates = updates.gates;
		return this.store.update(id, cleaned);
	}

	deleteWorkflow(id: string): boolean {
		const workflow = this.store.get(id);
		if (!workflow) return false;
		this.store.remove(id);
		return true;
	}



	/**
	 * Validate workflow gates:
	 * 1. At least one gate required
	 * 2. Unique IDs within the workflow
	 * 3. All dependsOn references exist within the workflow
	 * 4. No self-references
	 * 5. No circular dependencies (topological sort)
	 */
	private validateGates(gates: WorkflowGate[]): void {
		if (!Array.isArray(gates) || gates.length === 0) {
			throw new Error("Workflow must have at least one gate");
		}

		const ids = new Set<string>();
		for (const gate of gates) {
			if (!gate.id || typeof gate.id !== "string") {
				throw new Error("Each gate must have an id");
			}
			if (!ID_PATTERN.test(gate.id)) {
				throw new Error(`Gate ID "${gate.id}" must be lowercase alphanumeric + hyphens (e.g. 'issue-analysis')`);
			}
			if (ids.has(gate.id)) {
				throw new Error(`Duplicate gate ID: "${gate.id}"`);
			}
			ids.add(gate.id);
		}

		for (const gate of gates) {
			if (!gate.name || typeof gate.name !== "string") {
				throw new Error(`Gate "${gate.id}" must have a name`);
			}

			if (Array.isArray(gate.dependsOn)) {
				for (const dep of gate.dependsOn) {
					if (dep === gate.id) {
						throw new Error(`Gate "${gate.id}" depends on itself`);
					}
					if (!ids.has(dep)) {
						throw new Error(`Gate "${gate.id}" depends on unknown "${dep}"`);
					}
				}
			}
		}

		// Check for circular dependencies via topological sort
		const gateMap = new Map(gates.map(g => [g.id, g]));
		const visited = new Set<string>();
		const visiting = new Set<string>();

		const visit = (id: string): void => {
			if (visited.has(id)) return;
			if (visiting.has(id)) {
				throw new Error(`Circular dependency detected involving "${id}"`);
			}
			visiting.add(id);
			const gate = gateMap.get(id)!;
			if (Array.isArray(gate.dependsOn)) {
				for (const dep of gate.dependsOn) {
					visit(dep);
				}
			}
			visiting.delete(id);
			visited.add(id);
		};

		for (const gate of gates) {
			visit(gate.id);
		}
	}
}

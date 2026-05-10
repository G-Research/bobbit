/**
 * Workflow gate dependency-DAG helpers.
 * Extracted from server.ts (commit: split server.ts).
 */
import type { Workflow } from "./workflow-store.js";

/** Check if gateId transitively depends on targetId in the workflow DAG. */
export function hasTransitiveDep(workflow: Workflow, gateId: string, targetId: string, visited = new Set<string>()): boolean {
	if (visited.has(gateId)) return false;
	visited.add(gateId);
	const gate = workflow.gates.find(g => g.id === gateId);
	if (!gate) return false;
	for (const dep of gate.dependsOn) {
		if (dep === targetId) return true;
		if (hasTransitiveDep(workflow, dep, targetId, visited)) return true;
	}
	return false;
}

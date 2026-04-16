/**
 * Pure gate dependency enforcement logic.
 *
 * Extracted from team-manager.ts spawnRole() and server.ts team/prompt handler
 * so it can be tested in isolation without server/store dependencies.
 */

export interface GateDef {
	id: string;
	name: string;
	dependsOn: string[];
	[key: string]: unknown; // allow extra fields from workflow gate definitions
}

export interface GateState {
	gateId: string;
	status: "pending" | "passed" | "failed";
	[key: string]: unknown;
}

/**
 * Check whether a workflow gate's upstream dependencies have all passed.
 *
 * Returns null if the operation is allowed, or an error message string if blocked.
 *
 * Used by:
 *   - team-manager.ts spawnRole() — throws GateDependencyError on non-null
 *   - server.ts team/prompt handler — returns 409 on non-null
 *   - server.ts gate signal handler (uses a simpler per-dep loop variant)
 */
export function checkGateDependencies(
	workflowGateId: string | undefined,
	workflowGates: GateDef[],
	gateStates: GateState[],
): string | null {
	if (!workflowGateId) return null;

	const wfGate = workflowGates.find(g => g.id === workflowGateId);
	if (!wfGate || !wfGate.dependsOn?.length) return null;

	const passedIds = new Set(
		gateStates.filter(g => g.status === "passed").map(g => g.gateId),
	);
	const notPassed = wfGate.dependsOn.filter(depId => !passedIds.has(depId));

	if (notPassed.length > 0) {
		const names = notPassed.map(id => {
			const def = workflowGates.find(g => g.id === id);
			return def ? `${def.name} (${id})` : id;
		});
		return `Upstream gate(s) not passed: ${names.join(", ")}. Cannot proceed for gate "${workflowGateId}" until dependencies are met.`;
	}

	return null;
}

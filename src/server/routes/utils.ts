import http from "node:http";
import type { Workflow } from "../agent/workflow-store.js";
import type { PreferencesStore } from "../agent/preferences-store.js";

/**
 * Parse the JSON body of an incoming request.
 * Returns `null` if parsing fails or body is empty.
 */
export function readBody(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("error", () => resolve(null));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch {
				resolve(null);
			}
		});
	});
}

/** Return preferences with sensitive keys (providerKey.*) filtered out. */
export function getSafePreferences(preferencesStore: PreferencesStore): Record<string, unknown> {
	const all = preferencesStore.getAll();
	const filtered: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(all)) {
		if (!key.startsWith("providerKey.")) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/** Broadcast preferences_changed with sensitive keys filtered out. */
export function broadcastPreferencesChanged(
	preferencesStore: PreferencesStore,
	broadcastToAll: (msg: Record<string, unknown>) => void,
): void {
	broadcastToAll({ type: "preferences_changed", preferences: getSafePreferences(preferencesStore) });
}

/**
 * Send a JSON response.
 */
export function json(res: http.ServerResponse, data: unknown, status = 200): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

/**
 * Check if `gateId` transitively depends on `targetId` in the workflow DAG.
 */
export function hasTransitiveDep(
	workflow: Workflow,
	gateId: string,
	targetId: string,
	visited = new Set<string>(),
): boolean {
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

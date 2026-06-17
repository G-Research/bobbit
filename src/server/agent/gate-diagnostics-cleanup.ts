import fs from "node:fs/promises";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export const GATE_DIAGNOSTICS_DIR = "gate-diagnostics";

export function safeGateDiagnosticsSegment(value: string): string {
	const trimmed = value.trim();
	return trimmed.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

function resolveStateDir(stateDir?: string): string {
	return stateDir ?? bobbitStateDir();
}

export function gateDiagnosticsRootDir(stateDir?: string): string {
	return path.join(resolveStateDir(stateDir), GATE_DIAGNOSTICS_DIR);
}

export function gateDiagnosticsGoalDir(goalId: string, stateDir?: string): string {
	return path.join(gateDiagnosticsRootDir(stateDir), safeGateDiagnosticsSegment(goalId));
}

export async function cleanupGateDiagnosticsForGoal(goalId: string, stateDir?: string): Promise<void> {
	await fs.rm(gateDiagnosticsGoalDir(goalId, stateDir), { recursive: true, force: true });
}

import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "./workflow-store.js";

export type GateStatus = "pending" | "passed" | "failed";

export interface GateSignalStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa";
	passed: boolean;
	skipped?: boolean;
	output: string;
	duration_ms: number;
	expect?: "success" | "failure";
	artifact?: {
		content: string;
		contentType: string;
		metadata?: Record<string, string>;
	};
}

export interface GateSignal {
	id: string;
	gateId: string;
	goalId: string;
	sessionId: string;
	timestamp: number;
	commitSha: string;
	metadata?: Record<string, string>;
	content?: string;
	contentVersion?: number;
	verification: {
		status: "running" | "passed" | "failed";
		steps: GateSignalStep[];
	};
}

export interface GateState {
	gateId: string;
	goalId: string;
	status: GateStatus;
	currentContent?: string;
	currentContentVersion?: number;
	currentMetadata?: Record<string, string>;
	signals: GateSignal[];
	updatedAt: number;
}

function compositeKey(goalId: string, gateId: string): string {
	return `${goalId}::${gateId}`;
}

export class GateStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private gates: Map<string, GateState> = new Map();

	/** Optional callback invoked when any gate status changes (for bumping goal generation). */
	onStatusChange?: (goalId: string, gateId: string) => void;

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "gates.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (Array.isArray(data)) {
					for (const g of data) {
						if (g.gateId && g.goalId) {
							this.gates.set(compositeKey(g.goalId, g.gateId), g);
						}
					}
				}
			}
		} catch (err) {
			console.error("[gate-store] Failed to load persisted gates:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}
			const data = Array.from(this.gates.values());
			fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[gate-store] Failed to save gates:", err);
		}
	}

	/** Initialize pending gate states for a new goal. */
	initGatesForGoal(goalId: string, gateIds: string[]): void {
		const now = Date.now();
		for (const gateId of gateIds) {
			const key = compositeKey(goalId, gateId);
			if (!this.gates.has(key)) {
				this.gates.set(key, {
					gateId,
					goalId,
					status: "pending",
					signals: [],
					updatedAt: now,
				});
			}
		}
		this.save();
	}

	getGate(goalId: string, gateId: string): GateState | undefined {
		return this.gates.get(compositeKey(goalId, gateId));
	}

	getGatesForGoal(goalId: string): GateState[] {
		const result: GateState[] = [];
		for (const g of this.gates.values()) {
			if (g.goalId === goalId) result.push(g);
		}
		return result;
	}

	/** Append a signal to a gate's history. */
	recordSignal(signal: GateSignal): void {
		const key = compositeKey(signal.goalId, signal.gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.signals.push(signal);
		gate.updatedAt = Date.now();
		this.save();
	}

	updateGateStatus(goalId: string, gateId: string, status: GateStatus): void {
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.status = status;
		gate.updatedAt = Date.now();
		this.save();
		this.onStatusChange?.(goalId, gateId);
	}

	updateGateContent(goalId: string, gateId: string, content: string, version: number): void {
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentContent = content;
		gate.currentContentVersion = version;
		gate.updatedAt = Date.now();
		this.save();
	}

	updateGateMetadata(goalId: string, gateId: string, metadata: Record<string, string>): void {
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentMetadata = metadata;
		gate.updatedAt = Date.now();
		this.save();
	}

	/** Update a signal's verification results by signal ID. */
	updateSignalVerification(signalId: string, verification: GateSignal["verification"]): void {
		for (const gate of this.gates.values()) {
			const signal = gate.signals.find(s => s.id === signalId);
			if (signal) {
				if (signal.verification.status !== "running") return; // already finalized
				signal.verification = verification;
				gate.updatedAt = Date.now();
				this.save();
				return;
			}
		}
	}

	/**
	 * Reset downstream gates to pending when an upstream gate is re-signaled.
	 * Uses the workflow definition to find transitive dependents.
	 */
	cascadeReset(goalId: string, gateId: string, workflow: Workflow): void {
		const dependents = new Set<string>();
		const findDependents = (id: string) => {
			for (const gate of workflow.gates) {
				if (gate.dependsOn.includes(id) && !dependents.has(gate.id)) {
					dependents.add(gate.id);
					findDependents(gate.id);
				}
			}
		};
		findDependents(gateId);

		for (const depId of dependents) {
			const key = compositeKey(goalId, depId);
			const gate = this.gates.get(key);
			if (gate && gate.status !== "pending") {
				gate.status = "pending";
				gate.updatedAt = Date.now();
			}
		}
		if (dependents.size > 0) this.save();
	}

	/** Remove all gates for a goal (cleanup on goal deletion). */
	removeGoalGates(goalId: string): void {
		const keysToRemove: string[] = [];
		for (const [key, gate] of this.gates) {
			if (gate.goalId === goalId) keysToRemove.push(key);
		}
		for (const key of keysToRemove) {
			this.gates.delete(key);
		}
		if (keysToRemove.length > 0) this.save();
	}
}

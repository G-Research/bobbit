import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "./workflow-store.js";

export type GateStatus = "pending" | "passed" | "failed";

/**
 * Owner kind for a gate. Goals are the legacy/default owner; missions own
 * their own gate streams (charter, plan-review, goal-plan, execution,
 * integration, mission-pr) for the mission-orchestration feature.
 *
 * On disk, records without `ownerKind` default to `"goal"` with
 * `ownerId = goalId` (lazy migration on load — see §5.4 of the
 * mission-orchestration design doc).
 */
export type GateOwnerKind = "goal" | "mission";

export interface GateSignalStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa" | "integration-test";
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
	/** Owner discriminator. Optional on older records — defaults to `"goal"`. */
	ownerKind?: GateOwnerKind;
	/** New canonical owner id. Optional on older records — defaults to `goalId`. */
	ownerId?: string;
	/**
	 * @deprecated Backward-compat alias. For `ownerKind === "goal"` this equals
	 * `ownerId`. For mission-owned signals the field is still populated
	 * (mirrored from `ownerId`) so legacy reads / log lines don't crash.
	 */
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
	/** Owner discriminator. Optional on older records — defaults to `"goal"`. */
	ownerKind?: GateOwnerKind;
	/** New canonical owner id. Optional on older records — defaults to `goalId`. */
	ownerId?: string;
	/** @deprecated Backward-compat alias; mirrors `ownerId`. */
	goalId: string;
	status: GateStatus;
	currentContent?: string;
	currentContentVersion?: number;
	currentMetadata?: Record<string, string>;
	signals: GateSignal[];
	updatedAt: number;
}

/**
 * New composite key. The kind prefix prevents goal-id and mission-id
 * collisions (extremely unlikely in practice with ULIDs/UUIDs but cheap to
 * defend against).
 */
function compositeKey(kind: GateOwnerKind, ownerId: string, gateId: string): string {
	return `${kind}:${ownerId}::${gateId}`;
}

/** Hydrate optional ownerKind/ownerId fields from legacy goalId-only records. */
function normalizeSignal(s: GateSignal): GateSignal {
	if (!s.ownerKind) s.ownerKind = "goal";
	if (!s.ownerId) s.ownerId = s.goalId;
	if (!s.goalId) s.goalId = s.ownerId!;
	return s;
}

function normalizeState(g: GateState): GateState {
	if (!g.ownerKind) g.ownerKind = "goal";
	if (!g.ownerId) g.ownerId = g.goalId;
	if (!g.goalId) g.goalId = g.ownerId!;
	if (Array.isArray(g.signals)) g.signals.forEach(normalizeSignal);
	return g;
}

export class GateStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private gates: Map<string, GateState> = new Map();

	/**
	 * Optional callback invoked when any gate status changes (for bumping goal
	 * generation / mission generation). Called with the canonical
	 * `(ownerKind, ownerId, gateId)` triple. Single-arg legacy callers can
	 * ignore `ownerKind` and treat `ownerId` as `goalId`.
	 */
	onStatusChange?: (ownerKind: GateOwnerKind, ownerId: string, gateId: string) => void;

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
						if (!g.gateId) continue;
						// Lazy migration: legacy records have only goalId; new
						// records have ownerKind/ownerId. Either is valid input.
						const norm = normalizeState(g);
						if (!norm.ownerKind || !norm.ownerId) continue;
						this.gates.set(compositeKey(norm.ownerKind, norm.ownerId, norm.gateId), norm);
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

	// -----------------------------------------------------------------------
	// New (kind, ownerId) API — canonical going forward.
	// -----------------------------------------------------------------------

	/** Initialize pending gate states for a new owner (goal or mission). */
	initGatesFor(kind: GateOwnerKind, ownerId: string, gateIds: string[]): void {
		const now = Date.now();
		let dirty = false;
		for (const gateId of gateIds) {
			const key = compositeKey(kind, ownerId, gateId);
			if (!this.gates.has(key)) {
				this.gates.set(key, {
					gateId,
					ownerKind: kind,
					ownerId,
					goalId: ownerId, // mirror for backward compat
					status: "pending",
					signals: [],
					updatedAt: now,
				});
				dirty = true;
			}
		}
		if (dirty) this.save();
	}

	getGateFor(kind: GateOwnerKind, ownerId: string, gateId: string): GateState | undefined {
		return this.gates.get(compositeKey(kind, ownerId, gateId));
	}

	getGatesFor(kind: GateOwnerKind, ownerId: string): GateState[] {
		const result: GateState[] = [];
		for (const g of this.gates.values()) {
			if ((g.ownerKind ?? "goal") === kind && (g.ownerId ?? g.goalId) === ownerId) {
				result.push(g);
			}
		}
		return result;
	}

	updateGateStatusFor(kind: GateOwnerKind, ownerId: string, gateId: string, status: GateStatus): void {
		const key = compositeKey(kind, ownerId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.status = status;
		gate.updatedAt = Date.now();
		this.save();
		this.onStatusChange?.(kind, ownerId, gateId);
	}

	updateGateContentFor(kind: GateOwnerKind, ownerId: string, gateId: string, content: string, version: number): void {
		const key = compositeKey(kind, ownerId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentContent = content;
		gate.currentContentVersion = version;
		gate.updatedAt = Date.now();
		this.save();
	}

	updateGateMetadataFor(kind: GateOwnerKind, ownerId: string, gateId: string, metadata: Record<string, string>): void {
		const key = compositeKey(kind, ownerId, gateId);
		const gate = this.gates.get(key);
		if (!gate) return;
		gate.currentMetadata = metadata;
		gate.updatedAt = Date.now();
		this.save();
	}

	cascadeResetFor(kind: GateOwnerKind, ownerId: string, gateId: string, workflow: Workflow): void {
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
			const key = compositeKey(kind, ownerId, depId);
			const gate = this.gates.get(key);
			if (gate && gate.status !== "pending") {
				gate.status = "pending";
				gate.updatedAt = Date.now();
			}
		}
		if (dependents.size > 0) this.save();
	}

	removeGatesFor(kind: GateOwnerKind, ownerId: string): void {
		const keysToRemove: string[] = [];
		for (const [key, gate] of this.gates) {
			if ((gate.ownerKind ?? "goal") === kind && (gate.ownerId ?? gate.goalId) === ownerId) {
				keysToRemove.push(key);
			}
		}
		for (const key of keysToRemove) {
			this.gates.delete(key);
		}
		if (keysToRemove.length > 0) this.save();
	}

	// -----------------------------------------------------------------------
	// Legacy goalId-keyed API — thin wrappers that delegate to the (kind,
	// ownerId) methods with kind="goal". Kept indefinitely for backward
	// compatibility; new server code should prefer the *For variants.
	// -----------------------------------------------------------------------

	/** Initialize pending gate states for a new goal. */
	initGatesForGoal(goalId: string, gateIds: string[]): void {
		this.initGatesFor("goal", goalId, gateIds);
	}

	getGate(goalId: string, gateId: string): GateState | undefined {
		return this.getGateFor("goal", goalId, gateId);
	}

	getGatesForGoal(goalId: string): GateState[] {
		return this.getGatesFor("goal", goalId);
	}

	updateGateStatus(goalId: string, gateId: string, status: GateStatus): void {
		this.updateGateStatusFor("goal", goalId, gateId, status);
	}

	updateGateContent(goalId: string, gateId: string, content: string, version: number): void {
		this.updateGateContentFor("goal", goalId, gateId, content, version);
	}

	updateGateMetadata(goalId: string, gateId: string, metadata: Record<string, string>): void {
		this.updateGateMetadataFor("goal", goalId, gateId, metadata);
	}

	cascadeReset(goalId: string, gateId: string, workflow: Workflow): void {
		this.cascadeResetFor("goal", goalId, gateId, workflow);
	}

	/** Remove all gates for a goal (cleanup on goal deletion). */
	removeGoalGates(goalId: string): void {
		this.removeGatesFor("goal", goalId);
	}

	// -----------------------------------------------------------------------
	// Owner-agnostic (operate by signal id; no migration needed).
	// -----------------------------------------------------------------------

	/** Append a signal to a gate's history. */
	recordSignal(signal: GateSignal): void {
		// Hydrate canonical fields if caller provided only legacy goalId.
		const norm = normalizeSignal(signal);
		const kind = norm.ownerKind ?? "goal";
		const ownerId = norm.ownerId ?? norm.goalId;
		const gate = this.gates.get(compositeKey(kind, ownerId, norm.gateId));
		if (!gate) return;
		gate.signals.push(norm);
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
}

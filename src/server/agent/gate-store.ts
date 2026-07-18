import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Workflow } from "./workflow-store.js";
import type { GateStepDiagnostics } from "../gate-diagnostics.js";

export type GateStatus = "pending" | "passed" | "failed" | "bypassed";

export interface VerificationTimeoutInfo {
	/** Resolved per-turn review allowance. */
	configuredSeconds: number;
	/** Elapsed time for the specific active turn that exhausted its allowance. */
	elapsedMs: number;
}

export interface GateSignalStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa" | "subgoal" | "human-signoff";
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
	/** Durable diagnostics for completed command steps, stored under Bobbit state. */
	diagnostics?: GateStepDiagnostics;
	/**
	 * Lifecycle status for in-flight rows and durable terminal verdict for
	 * completed rows. Set on initial enumeration by
	 * `VerificationHarness.beginVerification()` so the gate-store signal
	 * carries useful progress information from the moment it is recorded,
	 * then preserved as `passed`/`failed`/`timeout`/`skipped` for historical rendering.
	 */
	status?: "waiting" | "running" | "passed" | "failed" | "timeout" | "skipped";
	/** Present only when a review turn exhausted its configured allowance. */
	timeout?: VerificationTimeoutInfo;
	/** Optional phase number, mirrored from the workflow VerifyStep for ordering. */
	phase?: number;
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
	/** Signals at or before this timestamp are ineligible for verification-step cache reuse. */
	verificationCacheInvalidatedAt?: number;
	updatedAt: number;
}

export interface GateResetResult {
	requestedGateId: string;
	affectedGateIds: string[];
	changedGateIds: string[];
	unchangedGateIds: string[];
	previousStatuses: Record<string, GateStatus>;
}

function compositeKey(goalId: string, gateId: string): string {
	return `${goalId}::${gateId}`;
}

export class GateStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly fs: FsLike;
	private gates: Map<string, GateState> = new Map();

	/** Optional callback invoked when gate summary truth changes (for bumping goal generation). */
	onStatusChange?: (goalId: string, gateId: string) => void;

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.fs = fsImpl;
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "gates.json");
		this.load();
	}

	private load(): void {
		try {
			if (this.fs.existsSync(this.storeFile)) {
				const data = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
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
			if (!this.fs.existsSync(this.storeDir)) {
				this.fs.mkdirSync(this.storeDir, { recursive: true });
			}
			const data = Array.from(this.gates.values());
			this.fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[gate-store] Failed to save gates:", err);
		}
	}

	/** Atomic, fail-loud persistence used by cross-store lifecycle transactions. */
	private saveStrict(): void {
		if (!this.fs.existsSync(this.storeDir)) {
			this.fs.mkdirSync(this.storeDir, { recursive: true });
		}
		const tempFile = `${this.storeFile}.reset-${randomUUID()}.tmp`;
		try {
			const data = Array.from(this.gates.values());
			this.fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
			this.fs.renameSync(tempFile, this.storeFile);
		} catch (err) {
			try {
				if (this.fs.existsSync(tempFile)) this.fs.unlinkSync(tempFile);
			} catch { /* best-effort temp cleanup */ }
			throw err;
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

	/**
	 * Reconcile persisted gate state after replacing a goal's workflow snapshot.
	 * Existing gates retain their exact state unless explicitly marked modified.
	 */
	reconcileGatesForGoal(
		goalId: string,
		nextGateIds: Iterable<string>,
		modifiedGateIds: Iterable<string> = [],
	): void {
		const remainingGateIds = new Set(nextGateIds);
		const modifiedIds = new Set(modifiedGateIds);
		const now = Date.now();
		let changed = false;

		for (const [key, gate] of this.gates) {
			if (gate.goalId !== goalId) continue;

			if (!remainingGateIds.has(gate.gateId)) {
				this.gates.delete(key);
				changed = true;
				continue;
			}

			remainingGateIds.delete(gate.gateId);
			if (modifiedIds.has(gate.gateId)) {
				gate.status = "pending";
				gate.verificationCacheInvalidatedAt = now;
				gate.updatedAt = now;
				changed = true;
			}
		}

		for (const gateId of remainingGateIds) {
			this.gates.set(compositeKey(goalId, gateId), {
				gateId,
				goalId,
				status: "pending",
				signals: [],
				updatedAt: now,
			});
			changed = true;
		}

		if (changed) this.save();
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
		this.onStatusChange?.(signal.goalId, signal.gateId);
	}

	/**
	 * Human-only bypass: force a gate past verification. Appends a synthetic
	 * audit signal (so the action is auditable like any other signal), sets the
	 * gate status to "bypassed", persists, and fires onStatusChange.
	 *
	 * This is an honesty-system override surfaced ONLY via the human UI — it is
	 * never advertised to agents (no MCP tool). See docs/design Human Gate Bypass.
	 */
	bypassGate(goalId: string, gateId: string, opts: { whyBypassed: string; whoAmI: string }): GateSignal {
		const key = compositeKey(goalId, gateId);
		const gate = this.gates.get(key);
		if (!gate) {
			throw new Error(`Unknown gate: ${gateId}`);
		}
		const now = Date.now();
		const signal: GateSignal = {
			id: `bypass-${randomUUID()}`,
			gateId,
			goalId,
			sessionId: "human-bypass",
			timestamp: now,
			commitSha: "",
			content: opts.whyBypassed,
			metadata: {
				bypass: "true",
				whyBypassed: opts.whyBypassed,
				whoAmI: opts.whoAmI,
				bypassedAt: String(now),
			},
			verification: { status: "passed", steps: [] },
		};
		gate.signals.push(signal);
		gate.status = "bypassed";
		gate.updatedAt = now;
		this.save();
		this.onStatusChange?.(goalId, gateId);
		return signal;
	}

	/** Returns the last signal whose metadata.bypass === "true", if any. */
	getLatestBypassSignal(gate: GateState): GateSignal | undefined {
		for (let i = gate.signals.length - 1; i >= 0; i--) {
			if (gate.signals[i]?.metadata?.bypass === "true") return gate.signals[i];
		}
		return undefined;
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

	private getDependentGateIds(gateId: string, workflow: Workflow, includeRequested: boolean): string[] {
		const gateIds = new Set(workflow.gates.map(g => g.id));
		if (!gateIds.has(gateId)) {
			throw new Error(`Unknown gate: ${gateId}`);
		}

		const adjacency = new Map<string, string[]>();
		for (const gate of workflow.gates) {
			for (const depId of gate.dependsOn) {
				const list = adjacency.get(depId) ?? [];
				list.push(gate.id);
				adjacency.set(depId, list);
			}
		}

		const result: string[] = [];
		const visited = new Set<string>();
		const queue = [gateId];
		visited.add(gateId);
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (includeRequested || current !== gateId) result.push(current);
			for (const depId of adjacency.get(current) ?? []) {
				if (visited.has(depId)) continue;
				visited.add(depId);
				queue.push(depId);
			}
		}
		return result;
	}

	/**
	 * Reset a selected gate and every transitive dependent to pending.
	 * Preserves signal history, current content, content version, and metadata.
	 */
	resetGateAndDependents(goalId: string, gateId: string, workflow: Workflow): GateResetResult {
		return this.resetGateAndDependentsInternal(goalId, gateId, workflow, false);
	}

	/** Reset gates with atomic, fail-loud persistence for lifecycle transactions. */
	resetGateAndDependentsStrict(goalId: string, gateId: string, workflow: Workflow): GateResetResult {
		return this.resetGateAndDependentsInternal(goalId, gateId, workflow, true);
	}

	private resetGateAndDependentsInternal(
		goalId: string,
		gateId: string,
		workflow: Workflow,
		strict: boolean,
	): GateResetResult {
		const affectedGateIds = this.getDependentGateIds(gateId, workflow, true);
		const changedGateIds: string[] = [];
		const unchangedGateIds: string[] = [];
		const previousStatuses: Record<string, GateStatus> = {};
		const snapshots = new Map<string, { status: GateStatus; updatedAt: number; cacheAt?: number; hadCacheAt: boolean }>();
		const now = Date.now();

		for (const affectedGateId of affectedGateIds) {
			const key = compositeKey(goalId, affectedGateId);
			const gate = this.gates.get(key);
			const previousStatus = gate?.status ?? "pending";
			previousStatuses[affectedGateId] = previousStatus;

			if (gate) {
				snapshots.set(key, {
					status: gate.status,
					updatedAt: gate.updatedAt,
					cacheAt: gate.verificationCacheInvalidatedAt,
					hadCacheAt: Object.prototype.hasOwnProperty.call(gate, "verificationCacheInvalidatedAt"),
				});
				gate.verificationCacheInvalidatedAt = now;
				gate.updatedAt = now;
			}

			if (gate && gate.status !== "pending") {
				gate.status = "pending";
				changedGateIds.push(affectedGateId);
			} else {
				unchangedGateIds.push(affectedGateId);
			}
		}

		try {
			if (affectedGateIds.length > 0) {
				if (strict) this.saveStrict();
				else this.save();
			}
		} catch (err) {
			for (const [key, snapshot] of snapshots) {
				const gate = this.gates.get(key);
				if (!gate) continue;
				gate.status = snapshot.status;
				gate.updatedAt = snapshot.updatedAt;
				if (snapshot.hadCacheAt) gate.verificationCacheInvalidatedAt = snapshot.cacheAt;
				else delete gate.verificationCacheInvalidatedAt;
			}
			throw err;
		}
		for (const changedGateId of changedGateIds) {
			if (!strict) {
				this.onStatusChange?.(goalId, changedGateId);
				continue;
			}
			try {
				this.onStatusChange?.(goalId, changedGateId);
			} catch (err) {
				// Persistence has committed. Observer failures must not make the
				// coordinator compensate the goal back to complete over pending gates.
				console.error(`[gate-store] Status observer failed after strict reset ${goalId}/${changedGateId}:`, err);
			}
		}

		return {
			requestedGateId: gateId,
			affectedGateIds,
			changedGateIds,
			unchangedGateIds,
			previousStatuses,
		};
	}

	/**
	 * Reset downstream gates to pending when an upstream gate is re-signaled.
	 * Uses the workflow definition to find transitive dependents.
	 */
	cascadeReset(goalId: string, gateId: string, workflow: Workflow): void {
		const dependents = this.getDependentGateIds(gateId, workflow, false);
		const changedGateIds: string[] = [];
		const now = Date.now();

		for (const depId of dependents) {
			const key = compositeKey(goalId, depId);
			const gate = this.gates.get(key);
			if (gate && gate.status !== "pending") {
				gate.status = "pending";
				gate.updatedAt = now;
				changedGateIds.push(depId);
			}
		}
		if (changedGateIds.length > 0) this.save();
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

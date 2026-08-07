import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import type { GoalState, GoalStore } from "./goal-store.js";
import type { GateResetResult, GateStatus, GateStore } from "./gate-store.js";
import type { Workflow } from "./workflow-store.js";

export interface GateResetIntent {
	id: string;
	goalId: string;
	gateId: string;
	affectedGateIds: string[];
	previousStatuses: Record<string, GateStatus>;
	previousState: GoalState;
	reopenRequired: boolean;
	createdAt: number;
}

/**
 * Project-scoped write-ahead log for the goal+gate reset transaction.
 *
 * An intent is durable before either store changes. Recovery replays the
 * state-first transition and idempotent gate reset, so every crash point is
 * either complete+resolved, in-progress+resolved, or in-progress+pending —
 * never complete+pending.
 */
export class GateResetIntentStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly fs: FsLike;
	private intents = new Map<string, GateResetIntent>();
	/** Volatile acknowledgement used only when intent cleanup fails after rearm. */
	private runtimeRearmed = new Set<string>();

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "gate-reset-intents.json");
		this.fs = fsImpl;
		this.load();
	}

	private load(): void {
		try {
			if (!this.fs.existsSync(this.storeFile)) return;
			const parsed = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
			if (!Array.isArray(parsed)) return;
			for (const candidate of parsed) {
				if (!candidate?.id || !candidate?.goalId || !candidate?.gateId) continue;
				this.intents.set(candidate.goalId, candidate as GateResetIntent);
			}
		} catch (err) {
			console.error("[gate-reset-intent] Failed to load reset intents:", err);
		}
	}

	private persist(intents: Map<string, GateResetIntent>): void {
		if (!this.fs.existsSync(this.storeDir)) {
			this.fs.mkdirSync(this.storeDir, { recursive: true });
		}
		const tempFile = `${this.storeFile}.${randomUUID()}.tmp`;
		try {
			this.fs.writeFileSync(tempFile, JSON.stringify(Array.from(intents.values()), null, 2), "utf-8");
			this.fs.renameSync(tempFile, this.storeFile);
		} catch (err) {
			try {
				if (this.fs.existsSync(tempFile)) this.fs.unlinkSync(tempFile);
			} catch { /* best-effort temp cleanup */ }
			throw err;
		}
	}

	get(goalId: string): GateResetIntent | undefined {
		return this.intents.get(goalId);
	}

	getAll(): GateResetIntent[] {
		return Array.from(this.intents.values());
	}

	begin(input: Omit<GateResetIntent, "id" | "createdAt">): { intent: GateResetIntent; resumed: boolean } {
		const existing = this.intents.get(input.goalId);
		if (existing) {
			if (existing.gateId !== input.gateId) {
				throw new Error(`Gate reset already in progress for goal ${input.goalId}`);
			}
			return { intent: existing, resumed: true };
		}
		const intent: GateResetIntent = { ...input, id: randomUUID(), createdAt: Date.now() };
		const next = new Map(this.intents);
		next.set(intent.goalId, intent);
		this.persist(next);
		this.intents = next;
		return { intent, resumed: false };
	}

	clear(intent: GateResetIntent): void {
		const current = this.intents.get(intent.goalId);
		if (!current || current.id !== intent.id) return;
		const next = new Map(this.intents);
		next.delete(intent.goalId);
		this.persist(next);
		this.intents = next;
		this.runtimeRearmed.delete(intent.id);
	}

	markRuntimeRearmed(intent: GateResetIntent): void {
		this.runtimeRearmed.add(intent.id);
	}

	wasRuntimeRearmed(intent: GateResetIntent): boolean {
		return this.runtimeRearmed.has(intent.id);
	}
}

export class GateResetCoordinator {
	readonly intents: GateResetIntentStore;
	/** Settles once boot-time WAL replay has attempted every retained intent. */
	readonly recovery: Promise<void>;

	constructor(
		stateDir: string,
		private readonly goalStore: GoalStore,
		private readonly gateStore: GateStore,
		fsImpl: FsLike = realFs,
	) {
		this.intents = new GateResetIntentStore(stateDir, fsImpl);
		// Restore every valid retained reset in memory before starting any async
		// publication. Boot/runtime observers must never see a completed goal or a
		// passed dependent while its durable WAL says that reset is pending.
		this.restorePendingInMemory();
		// Recovery is fail-loud per transaction but never blocks gateway boot. The
		// retained WAL is replayed again on a later restart if I/O remains down.
		this.recovery = this.recoverPending();
	}

	/**
	 * Make retained WAL intent state synchronously visible, then let recovery
	 * publish the same idempotent transition with its strict state-first fence.
	 * The ordinary mutations only schedule writes; recoverPending immediately
	 * replaces those schedules with strict publication barriers.
	 */
	private restorePendingInMemory(): void {
		for (const intent of this.intents.getAll()) {
			try {
				const goal = this.goalStore.get(intent.goalId);
				if (!goal || goal.archived || goal.paused || goal.state === "shelved") continue;
				if (!goal.workflow || !goal.workflow.gates.some(gate => gate.id === intent.gateId)) continue;

				if (intent.reopenRequired) {
					if (goal.state === "complete") {
						this.goalStore.update(intent.goalId, { state: "in-progress" });
					} else if (goal.state !== "in-progress") {
						throw new Error(`Cannot recover reset for goal ${intent.goalId} in state ${goal.state}`);
					}
				}

				// Its mutations are synchronous; retain/log malformed intent failures
				// rather than allowing an unhandled rejection during construction.
				void this.gateStore.resetGateAndDependentsInMemory(intent.goalId, intent.gateId, goal.workflow).catch(err => {
					console.error(`[gate-reset-intent] Failed to restore reset ${intent.id} in memory:`, err);
				});
			} catch (err) {
				// Retain the WAL. The strict recovery pass below logs and retries it on
				// the next restart if the snapshot remains invalid or I/O is unavailable.
				console.error(`[gate-reset-intent] Failed to restore reset ${intent.id} in memory:`, err);
			}
		}
	}

	begin(input: Omit<GateResetIntent, "id" | "createdAt">): { intent: GateResetIntent; resumed: boolean } {
		return this.intents.begin(input);
	}

	async commitDurable(intent: GateResetIntent, workflow: Workflow): Promise<GateResetResult> {
		if (intent.reopenRequired) {
			const goal = this.goalStore.get(intent.goalId);
			if (!goal) throw new Error(`Goal ${intent.goalId} no longer exists`);
			if (goal.state !== "complete" && goal.state !== "in-progress") {
				throw new Error(`Cannot recover reset for goal ${intent.goalId} in state ${goal.state}`);
			}
			// Also fence an already in-progress goal. Boot recovery may have made
			// that state synchronously visible without publishing it yet; gates must
			// never become durable before this state transition.
			if (!await this.goalStore.updateStrict(intent.goalId, { state: "in-progress" })) {
				throw new Error(`Goal ${intent.goalId} no longer exists`);
			}
		}
		return this.gateStore.resetGateAndDependentsStrict(intent.goalId, intent.gateId, workflow);
	}

	complete(intent: GateResetIntent): void {
		this.intents.clear(intent);
	}

	/** Best-effort controlled abort. Any failure deliberately leaves the WAL for boot recovery. */
	async abort(intent: GateResetIntent): Promise<void> {
		if (intent.reopenRequired && this.goalStore.get(intent.goalId)?.state === "in-progress") {
			await this.goalStore.updateStrict(intent.goalId, { state: intent.previousState });
		}
		this.intents.clear(intent);
	}

	private async recoverPending(): Promise<void> {
		for (const intent of this.intents.getAll()) {
			try {
				const goal = this.goalStore.get(intent.goalId);
				if (!goal || goal.archived || goal.paused || goal.state === "shelved") {
					// A later explicit dormant/delete transition wins. Recovery must never
					// implicitly resume dormant work.
					this.intents.clear(intent);
					continue;
				}
				if (!goal.workflow || !goal.workflow.gates.some(gate => gate.id === intent.gateId)) {
					this.intents.clear(intent);
					continue;
				}
				await this.commitDurable(intent, goal.workflow);
				this.intents.clear(intent);
				console.log(`[gate-reset-intent] Recovered reset ${intent.id} for ${intent.goalId}/${intent.gateId}`);
			} catch (err) {
				// Retain the intent. A future restart retries the idempotent replay.
				console.error(`[gate-reset-intent] Failed to recover reset ${intent.id}:`, err);
			}
		}
	}
}

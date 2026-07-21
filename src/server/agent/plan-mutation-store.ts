/**
 * Persistent store for pending plan-mutation requests — Phase 4 of nested
 * goals.
 *
 * When `PATCH /api/goals/:id/plan` produces a verdict that requires user
 * approval (expansion always; fix-up under strict; restructure on a paused
 * goal), the proposed steps are persisted here keyed by `(goalId,
 * requestId)` and the user later approves/rejects via
 * `POST /api/goals/:id/mutation/:requestId/decision`.
 *
 * On-disk layout: `<stateDir>/plan-mutations/<goalId>.json` holding an
 * array of `PendingMutation`. One file per goal; small and easy to
 * inspect. 24h expiry on each request — `pruneExpired` is idempotent and
 * cheap to call from a periodic sweep.
 *
 * Persistence is asynchronous. Read-modify-write operations are serialized
 * per goal so route writes and the periodic prune cannot lose one another's
 * updates, while pruning separate goals uses a small concurrency ceiling.
 */

import type { Clock, FsLike } from "../gateway-deps.js";
import { realClock, realFs } from "../gateway-deps.js";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { ClassifierPlanStep, ClassifyMutationDiff, MutationKind } from "./plan-mutation.js";

export interface PendingMutation {
	goalId: string;
	requestId: string;
	kind: MutationKind;
	proposedSteps: ClassifierPlanStep[];
	summary: string;
	diff: ClassifyMutationDiff;
	uncoveredCriteria?: string[];
	createdAt: number;
	/** Epoch ms — entries past this point are removed by pruneExpired. */
	expiresAt: number;
}

export type PlanMutationDecisionResult<T> =
	| { found: true; value: T }
	| { found: false };

/** 24h TTL — see SUBGOALS-SPEC §3.6. */
export const DEFAULT_MUTATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Daily sweep cadence for `pruneExpired`. */
export const DEFAULT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Keep a wide mutation directory from issuing unbounded concurrent I/O. */
export const PLAN_MUTATION_PRUNE_CONCURRENCY = 4;

const PLAN_MUTATION_PRUNE_YIELD_INTERVAL = 256;

interface PlanMutationDirectory {
	read(): Promise<Dirent | null>;
	close(): Promise<void>;
}

type PlanMutationAsyncFs = FsLike["promises"] & {
	opendir(dirPath: string): Promise<PlanMutationDirectory>;
};

function isEnoent(err: unknown): boolean {
	return !!err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function yieldPruneTraversal(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

export class PlanMutationStore {
	private readonly dir: string;
	private readonly fs: FsLike;
	private readonly clock: Clock;
	private readonly goalOperations = new Map<string, Promise<void>>();
	private sweepTimer?: ReturnType<Clock["setInterval"]>;
	private sweepRun?: Promise<number>;
	private sweepGeneration = 0;
	private sweepStopped = true;

	constructor(stateDir: string, opts?: { startSweep?: boolean; sweepIntervalMs?: number }, fsImpl: FsLike = realFs, clock: Clock = realClock) {
		this.fs = fsImpl;
		this.clock = clock;
		this.dir = path.join(stateDir, "plan-mutations");
		// Daily best-effort sweep so the 24h TTL actually trims disk usage
		// instead of relying on read-time filtering only. Opt-out for tests
		// via `{ startSweep: false }` so timers don't keep the test runner
		// alive. The timer is `unref()`'d so it never blocks process exit.
		const startSweep = opts?.startSweep ?? true;
		if (startSweep) {
			const interval = opts?.sweepIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
			this.sweepStopped = false;
			const generation = ++this.sweepGeneration;
			const timer: ReturnType<Clock["setInterval"]> = this.clock.setInterval(() => {
				// clearInterval cannot retract a callback that is already queued. Fence
				// that callback against both this timer installation and shutdown so
				// stopSweep's awaited barrier cannot be followed by a late prune.
				if (this.sweepStopped || this.sweepGeneration !== generation || this.sweepTimer !== timer) return;
				void this.runScheduledSweep();
			}, interval);
			this.sweepTimer = timer;
			timer.unref?.();
		}
	}

	/** Cancel future sweeps and wait until the active sweep, if any, settles. */
	async stopSweep(): Promise<void> {
		if (!this.sweepStopped) {
			this.sweepStopped = true;
			this.sweepGeneration++;
		}
		const timer = this.sweepTimer;
		this.sweepTimer = undefined;
		if (timer) this.clock.clearInterval(timer);
		const active = this.sweepRun;
		if (active) await active.catch(() => undefined);
	}

	private runScheduledSweep(): Promise<number> {
		if (this.sweepRun) return this.sweepRun;

		const run = this.pruneExpired();
		this.sweepRun = run;
		void run.then(
			() => {
				if (this.sweepRun === run) this.sweepRun = undefined;
			},
			(err) => {
				console.warn("[plan-mutation-store] periodic sweep failed:", err);
				if (this.sweepRun === run) this.sweepRun = undefined;
			},
		);
		return run;
	}

	private fileFor(goalId: string): string {
		return path.join(this.dir, `${goalId}.json`);
	}

	private async ensureDir(): Promise<void> {
		try {
			await this.fs.promises.mkdir(this.dir, { recursive: true });
		} catch (err) {
			console.error("[plan-mutation-store] Failed to mkdir:", err);
		}
	}

	private async readFile(goalId: string): Promise<PendingMutation[]> {
		try {
			const raw = await this.fs.promises.readFile(this.fileFor(goalId), "utf-8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed as PendingMutation[];
		} catch (err) {
			if (!isEnoent(err)) {
				console.warn(`[plan-mutation-store] Failed to read mutations for ${goalId}:`, err);
			}
			return [];
		}
	}

	private async writeFile(goalId: string, mutations: PendingMutation[]): Promise<void> {
		await this.ensureDir();
		try {
			const file = this.fileFor(goalId);
			if (mutations.length === 0) {
				try {
					await this.fs.promises.unlink(file);
				} catch (err) {
					if (!isEnoent(err)) throw err;
				}
				return;
			}
			await this.fs.promises.writeFile(file, JSON.stringify(mutations, null, 2), "utf-8");
		} catch (err) {
			console.error(`[plan-mutation-store] Failed to write mutations for ${goalId}:`, err);
		}
	}

	/** Queue a read-modify-write operation behind earlier operations for one goal. */
	private mutateGoal<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
		const preceding = this.goalOperations.get(goalId) ?? Promise.resolve();
		const run = preceding.then(operation);
		const settled = run.then(() => undefined, () => undefined);
		this.goalOperations.set(goalId, settled);
		void settled.then(() => {
			if (this.goalOperations.get(goalId) === settled) this.goalOperations.delete(goalId);
		});
		return run;
	}

	/** Wait for preceding writes without blocking later writes from joining the queue. */
	private async readAfterWrites(goalId: string): Promise<PendingMutation[]> {
		const preceding = this.goalOperations.get(goalId);
		if (preceding) await preceding;
		return this.readFile(goalId);
	}

	put(m: PendingMutation): Promise<void> {
		return this.mutateGoal(m.goalId, async () => {
			const list = await this.readFile(m.goalId);
			// Replace if requestId already exists, otherwise append.
			const idx = list.findIndex(x => x.requestId === m.requestId);
			if (idx >= 0) {
				list[idx] = m;
			} else {
				list.push(m);
			}
			await this.writeFile(m.goalId, list);
		});
	}

	async get(goalId: string, requestId: string): Promise<PendingMutation | undefined> {
		return (await this.readAfterWrites(goalId)).find(m => m.requestId === requestId);
	}

	remove(goalId: string, requestId: string): Promise<boolean> {
		return this.mutateGoal(goalId, async () => {
			const list = await this.readFile(goalId);
			const idx = list.findIndex(m => m.requestId === requestId);
			if (idx < 0) return false;
			list.splice(idx, 1);
			await this.writeFile(goalId, list);
			return true;
		});
	}

	/**
	 * Atomically decide one pending request for a goal. The per-goal mutation
	 * queue remains held while `decision` runs, so no competing decision can
	 * read or remove the same request. The request is removed only after the
	 * callback resolves; a rejected callback leaves it pending for retry.
	 */
	decide<T>(
		goalId: string,
		requestId: string,
		decision: (pending: PendingMutation) => Promise<T>,
	): Promise<PlanMutationDecisionResult<T>> {
		return this.mutateGoal(goalId, async () => {
			const list = await this.readFile(goalId);
			const idx = list.findIndex(m => m.requestId === requestId);
			if (idx < 0) return { found: false } as const;

			const value = await decision(list[idx]);
			list.splice(idx, 1);
			await this.writeFile(goalId, list);
			return { found: true, value } as const;
		});
	}

	listForGoal(goalId: string): Promise<PendingMutation[]> {
		return this.readAfterWrites(goalId);
	}

	/**
	 * Sweep all mutation files for expired requests. Returns the count of
	 * removed entries. Idempotent and best-effort — failures on individual
	 * goals are logged and skipped.
	 */
	async pruneExpired(now: number = this.clock.now()): Promise<number> {
		let directory: PlanMutationDirectory;
		try {
			directory = await (this.fs.promises as PlanMutationAsyncFs).opendir(this.dir);
		} catch (err) {
			if (!isEnoent(err)) console.warn("[plan-mutation-store] pruneExpired failed:", err);
			return 0;
		}

		let removedTotal = 0;
		let entriesSinceYield = 0;
		let exhausted = false;
		try {
			while (!exhausted) {
				const goalIds: string[] = [];
				while (goalIds.length < PLAN_MUTATION_PRUNE_CONCURRENCY) {
					const entry = await directory.read();
					if (entry === null) {
						exhausted = true;
						break;
					}

					entriesSinceYield++;
					if (entry.name.endsWith(".json")) {
						goalIds.push(entry.name.slice(0, -".json".length));
					}
					if (entriesSinceYield >= PLAN_MUTATION_PRUNE_YIELD_INTERVAL) {
						entriesSinceYield = 0;
						await yieldPruneTraversal();
					}
				}

				const removedBatch = await Promise.all(goalIds.map(async goalId => {
					try {
						return await this.mutateGoal(goalId, async () => {
							const list = await this.readFile(goalId);
							const kept = list.filter(m => m.expiresAt > now);
							const removed = list.length - kept.length;
							if (removed > 0) await this.writeFile(goalId, kept);
							return removed;
						});
					} catch (err) {
						console.warn(`[plan-mutation-store] Failed to prune mutations for ${goalId}:`, err);
						return 0;
					}
				}));
				for (const removed of removedBatch) removedTotal += removed;
			}
		} catch (err) {
			if (!isEnoent(err)) console.warn("[plan-mutation-store] pruneExpired failed:", err);
		} finally {
			try {
				await directory.close();
			} catch (err) {
				if (!isEnoent(err)) console.warn("[plan-mutation-store] Failed to close prune directory:", err);
			}
		}
		return removedTotal;
	}
}

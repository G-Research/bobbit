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
 * Threading model: synchronous JSON-file rewrites mirror `GoalStore` —
 * the volume is tiny (a handful of entries per goal at most) and we want
 * the same crash-recovery semantics.
 */

import fs from "node:fs";
import path from "node:path";
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

/** 24h TTL — see SUBGOALS-SPEC §3.6. */
export const DEFAULT_MUTATION_TTL_MS = 24 * 60 * 60 * 1000;

export class PlanMutationStore {
	private readonly dir: string;

	constructor(stateDir: string) {
		this.dir = path.join(stateDir, "plan-mutations");
	}

	private fileFor(goalId: string): string {
		return path.join(this.dir, `${goalId}.json`);
	}

	private ensureDir(): void {
		try {
			if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
		} catch (err) {
			console.error("[plan-mutation-store] Failed to mkdir:", err);
		}
	}

	private readFile(goalId: string): PendingMutation[] {
		try {
			const f = this.fileFor(goalId);
			if (!fs.existsSync(f)) return [];
			const raw = fs.readFileSync(f, "utf-8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed as PendingMutation[];
		} catch (err) {
			console.warn(`[plan-mutation-store] Failed to read mutations for ${goalId}:`, err);
			return [];
		}
	}

	private writeFile(goalId: string, mutations: PendingMutation[]): void {
		this.ensureDir();
		try {
			const f = this.fileFor(goalId);
			if (mutations.length === 0) {
				if (fs.existsSync(f)) fs.unlinkSync(f);
				return;
			}
			fs.writeFileSync(f, JSON.stringify(mutations, null, 2), "utf-8");
		} catch (err) {
			console.error(`[plan-mutation-store] Failed to write mutations for ${goalId}:`, err);
		}
	}

	put(m: PendingMutation): void {
		const list = this.readFile(m.goalId);
		// Replace if requestId already exists, otherwise append.
		const idx = list.findIndex(x => x.requestId === m.requestId);
		if (idx >= 0) {
			list[idx] = m;
		} else {
			list.push(m);
		}
		this.writeFile(m.goalId, list);
	}

	get(goalId: string, requestId: string): PendingMutation | undefined {
		return this.readFile(goalId).find(m => m.requestId === requestId);
	}

	remove(goalId: string, requestId: string): boolean {
		const list = this.readFile(goalId);
		const idx = list.findIndex(m => m.requestId === requestId);
		if (idx < 0) return false;
		list.splice(idx, 1);
		this.writeFile(goalId, list);
		return true;
	}

	listForGoal(goalId: string): PendingMutation[] {
		return this.readFile(goalId);
	}

	/**
	 * Sweep all mutation files for expired requests. Returns the count of
	 * removed entries. Idempotent and best-effort — failures on individual
	 * goals are logged and skipped.
	 */
	pruneExpired(now: number = Date.now()): number {
		let removed = 0;
		try {
			if (!fs.existsSync(this.dir)) return 0;
			const entries = fs.readdirSync(this.dir);
			for (const name of entries) {
				if (!name.endsWith(".json")) continue;
				const goalId = name.slice(0, -".json".length);
				const list = this.readFile(goalId);
				const kept = list.filter(m => m.expiresAt > now);
				if (kept.length !== list.length) {
					removed += list.length - kept.length;
					this.writeFile(goalId, kept);
				}
			}
		} catch (err) {
			console.warn("[plan-mutation-store] pruneExpired failed:", err);
		}
		return removed;
	}
}

import fs from "node:fs";
import path from "node:path";

/**
 * Raw per-session cost counters as stored on disk and accumulated in memory.
 * `cacheHitRate` is intentionally NOT persisted — it is a derived field
 * computed at read time from `cacheReadTokens` and `inputTokens`. See
 * docs/design (Cache-Hit Metric).
 */
export interface RawSessionCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
}

/**
 * Public-facing session cost snapshot. Adds the derived `cacheHitRate`
 * to {@link RawSessionCost}. `cacheHitRate` is `null` when the denominator
 * (`cacheReadTokens + inputTokens`) is 0 — i.e. cold sessions, or providers
 * that do not report cache counters. UI renders `null` as `—`.
 */
export interface SessionCost extends RawSessionCost {
	cacheHitRate: number | null;
}

export interface UsageData {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
}

function emptyRaw(): RawSessionCost {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	};
}

/**
 * Derive the cache-hit rate from a raw cost snapshot.
 *
 * Formula: `cacheReadTokens / (cacheReadTokens + inputTokens)`. `cacheWriteTokens`
 * is intentionally excluded — writes are charged at full price and are not hits.
 * Returns `null` when the denominator is 0 so cold sessions render as `—`
 * rather than `0%`.
 */
export function deriveCacheHitRate(
	cost: Pick<RawSessionCost, "inputTokens" | "cacheReadTokens">,
): number | null {
	const denom = (cost.cacheReadTokens ?? 0) + (cost.inputTokens ?? 0);
	if (denom <= 0) return null;
	return (cost.cacheReadTokens ?? 0) / denom;
}

/** Decorate a raw cost with the derived `cacheHitRate` field. */
export function withDerivedFields(raw: RawSessionCost): SessionCost {
	return { ...raw, cacheHitRate: deriveCacheHitRate(raw) };
}

/**
 * Tracks cumulative per-session cost/usage data.
 * Persists to .bobbit/state/session-costs.json.
 * Same load-on-construct, write-on-mutate pattern as GoalStore/SessionStore.
 */
export class CostTracker {
	private costs: Map<string, RawSessionCost> = new Map();
	private readonly storeDir: string;
	private readonly storeFile: string;

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "session-costs.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (data && typeof data === "object" && !Array.isArray(data)) {
					for (const [id, cost] of Object.entries(data)) {
						if (id && cost && typeof cost === "object") {
							const c = cost as Record<string, unknown>;
							this.costs.set(id, {
								inputTokens: typeof c.inputTokens === "number" ? c.inputTokens : 0,
								outputTokens: typeof c.outputTokens === "number" ? c.outputTokens : 0,
								cacheReadTokens: typeof c.cacheReadTokens === "number" ? c.cacheReadTokens : 0,
								cacheWriteTokens: typeof c.cacheWriteTokens === "number" ? c.cacheWriteTokens : 0,
								totalCost: typeof c.totalCost === "number" ? c.totalCost : 0,
							});
						}
					}
				}
			}
		} catch (err) {
			console.error("[cost-tracker] Failed to load persisted costs:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}
			// Persist ONLY the raw counters. Derived fields (cacheHitRate) are
			// never written to disk — they are recomputed on every read.
			const data: Record<string, RawSessionCost> = {};
			for (const [id, cost] of this.costs) {
				data[id] = {
					inputTokens: cost.inputTokens,
					outputTokens: cost.outputTokens,
					cacheReadTokens: cost.cacheReadTokens,
					cacheWriteTokens: cost.cacheWriteTokens,
					totalCost: cost.totalCost,
				};
			}
			fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[cost-tracker] Failed to save costs:", err);
		}
	}

	/**
	 * Add usage data to the cumulative totals for a session.
	 * Handles partial usage objects — undefined fields are treated as 0.
	 * Returns a snapshot with the derived `cacheHitRate` populated.
	 */
	recordUsage(sessionId: string, usage: UsageData): SessionCost {
		const existing = this.costs.get(sessionId) ?? emptyRaw();
		existing.inputTokens += usage.inputTokens ?? 0;
		existing.outputTokens += usage.outputTokens ?? 0;
		existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
		existing.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		existing.totalCost += usage.cost ?? 0;
		existing.totalCost = Math.round(existing.totalCost * 1_000_000) / 1_000_000;
		this.costs.set(sessionId, existing);
		this.save();
		return withDerivedFields(existing);
	}

	getSessionCost(sessionId: string): SessionCost | undefined {
		const cost = this.costs.get(sessionId);
		return cost ? withDerivedFields(cost) : undefined;
	}

	/**
	 * Aggregate cost across multiple sessions (caller provides session IDs).
	 * Returns a combined SessionCost with the aggregate `cacheHitRate` derived
	 * from the aggregate `cacheReadTokens` and `inputTokens`. Sessions without
	 * cost data are skipped.
	 */
	getGoalCost(_goalId: string, sessionIds: string[]): SessionCost {
		const total = emptyRaw();
		for (const sid of sessionIds) {
			const c = this.costs.get(sid);
			if (c) {
				total.inputTokens += c.inputTokens;
				total.outputTokens += c.outputTokens;
				total.cacheReadTokens += c.cacheReadTokens;
				total.cacheWriteTokens += c.cacheWriteTokens;
				total.totalCost += c.totalCost;
			}
		}
		return withDerivedFields(total);
	}

	getAllCosts(): Map<string, SessionCost> {
		const out = new Map<string, SessionCost>();
		for (const [id, cost] of this.costs) {
			out.set(id, withDerivedFields(cost));
		}
		return out;
	}

	removeSession(sessionId: string): void {
		if (this.costs.delete(sessionId)) {
			this.save();
		}
	}
}

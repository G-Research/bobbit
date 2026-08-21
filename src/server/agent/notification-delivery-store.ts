import { randomUUID } from "node:crypto";
import path from "node:path";
import { realClock, realFs, type Clock, type FsLike } from "../gateway-deps.js";
import type { HostNotification } from "../../shared/extension-host/host-hooks.js";

export type NotificationDeliveryState = "pending" | "leased" | "accepted" | "cancelled" | "failed";

export interface NotificationDeliveryRow {
	deliveryId: string;
	projectId: string;
	staffId: string;
	triggerId: string;
	subscriberVersion: string;
	notification: HostNotification;
	safeContext?: Record<string, string | number | boolean>;
	state: NotificationDeliveryState;
	attempt: number;
	nextAttemptAt: number;
	leaseUntil?: number;
	/** Opaque compare-and-set fence for a single worker attempt. */
	leaseId?: string;
	rootCorrelationId: string;
	causationDepth: number;
	createdAt: number;
	updatedAt: number;
	diagnosticCode?: string;
}

/**
 * Per-project durable subscriber outbox. This deliberately stores only rows
 * for matching staff subscribers; it is not a notification journal.
 */
export class NotificationDeliveryStore {
	private readonly file: string;
	private readonly rows = new Map<string, NotificationDeliveryRow>();

	constructor(
		stateDir: string,
		readonly projectId: string,
		private readonly fs: FsLike = realFs,
		private readonly clock: Clock = realClock,
	) {
		this.file = path.join(stateDir, "notification-deliveries.json");
		this.load();
	}

	private load(): void {
		try {
			if (!this.fs.existsSync(this.file)) return;
			const decoded = JSON.parse(this.fs.readFileSync(this.file, "utf-8") as string) as unknown;
			if (!Array.isArray(decoded)) throw new Error("notification delivery store must be an array");
			for (const candidate of decoded) {
				if (!candidate || typeof candidate !== "object") continue;
				const row = candidate as NotificationDeliveryRow;
				if (typeof row.deliveryId !== "string" || this.rows.has(row.deliveryId)) continue;
				// Keep individually addressable malformed rows recoverable so the worker
				// can revalidate and durably fail them closed instead of silently skipping.
				if (!(["pending", "leased", "accepted", "cancelled", "failed"] as unknown[]).includes(row.state)) row.state = "pending";
				if (!Number.isFinite(row.attempt)) row.attempt = 0;
				if (!Number.isFinite(row.nextAttemptAt)) row.nextAttemptAt = 0;
				if (!Number.isFinite(row.createdAt)) row.createdAt = 0;
				if (!Number.isFinite(row.updatedAt)) row.updatedAt = 0;
				this.rows.set(row.deliveryId, row);
			}
		} catch (err) {
			console.error(`[notification-delivery-store] Failed to load project ${this.projectId}:`, err);
			this.rows.clear();
		}
	}

	private saveStrict(): void {
		const directory = path.dirname(this.file);
		if (!this.fs.existsSync(directory)) this.fs.mkdirSync(directory, { recursive: true });
		const temporary = `${this.file}.${process.pid}.${this.clock.now()}.${randomUUID()}.tmp`;
		try {
			this.fs.writeFileSync(temporary, JSON.stringify(Array.from(this.rows.values()), null, 2), "utf-8");
			this.fs.renameSync(temporary, this.file);
		} catch (err) {
			try { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); } catch { /* preserve original error */ }
			throw err;
		}
	}

	private mutateStrict<T>(mutation: () => T): T {
		const before = new Map(Array.from(this.rows, ([id, row]) => [id, structuredClone(row)]));
		try {
			const result = mutation();
			this.saveStrict();
			return result;
		} catch (err) {
			this.rows.clear();
			for (const [id, row] of before) this.rows.set(id, row);
			throw err;
		}
	}

	get(deliveryId: string): NotificationDeliveryRow | undefined {
		const row = this.rows.get(deliveryId);
		return row ? structuredClone(row) : undefined;
	}

	list(): NotificationDeliveryRow[] {
		return Array.from(this.rows.values(), (row) => structuredClone(row));
	}

	insertPending(row: NotificationDeliveryRow): { row: NotificationDeliveryRow; inserted: boolean } {
		if (row.projectId !== this.projectId || row.notification?.projectId !== this.projectId) {
			throw Object.assign(new Error("Notification delivery project partition mismatch"), { code: "PROJECT_PARTITION_MISMATCH" });
		}
		const existing = this.rows.get(row.deliveryId);
		if (existing) {
			const sameIdentity = existing.staffId === row.staffId
				&& existing.triggerId === row.triggerId
				&& existing.subscriberVersion === row.subscriberVersion
				&& JSON.stringify(existing.notification) === JSON.stringify(row.notification);
			if (!sameIdentity) {
				throw Object.assign(new Error(`Notification delivery identity collision: ${row.deliveryId}`), { code: "DELIVERY_IDENTITY_COLLISION" });
			}
			return { row: structuredClone(existing), inserted: false };
		}
		return this.mutateStrict(() => {
			this.rows.set(row.deliveryId, structuredClone(row));
			return { row: structuredClone(row), inserted: true };
		});
	}

	hasSubscriberRoot(rootCorrelationId: string, staffId: string, triggerId: string): boolean {
		return Array.from(this.rows.values()).some((row) =>
			row.rootCorrelationId === rootCorrelationId
			&& row.staffId === staffId
			&& row.triggerId === triggerId);
	}

	/** Claim pending or expired-leased rows and durably publish every lease. */
	claimDue(now: number, leaseMs: number, limit: number): NotificationDeliveryRow[] {
		const candidates = Array.from(this.rows.values())
			.filter((row) => (row.state === "pending" && row.nextAttemptAt <= now)
				|| (row.state === "leased" && (row.leaseUntil ?? 0) <= now))
			.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
			.slice(0, Math.max(0, limit));
		if (candidates.length === 0) return [];
		return this.mutateStrict(() => candidates.map((candidate) => {
			const row = this.rows.get(candidate.deliveryId)!;
			row.state = "leased";
			row.attempt += 1;
			row.leaseId = randomUUID();
			row.leaseUntil = now + leaseMs;
			row.updatedAt = now;
			delete row.diagnosticCode;
			return structuredClone(row);
		}));
	}

	/** Compare-and-set a leased row. Terminal rows can never be reopened. */
	finishLease(
		deliveryId: string,
		leaseId: string,
		state: "accepted" | "failed" | "cancelled" | "pending",
		options: { nextAttemptAt?: number; diagnosticCode?: string } = {},
	): boolean {
		const current = this.rows.get(deliveryId);
		if (!current || current.state !== "leased" || current.leaseId !== leaseId) return false;
		return this.mutateStrict(() => {
			const row = this.rows.get(deliveryId)!;
			if (row.state !== "leased" || row.leaseId !== leaseId) return false;
			row.state = state;
			row.updatedAt = this.clock.now();
			delete row.leaseId;
			delete row.leaseUntil;
			if (options.nextAttemptAt !== undefined) row.nextAttemptAt = options.nextAttemptAt;
			if (options.diagnosticCode) row.diagnosticCode = options.diagnosticCode;
			return true;
		});
	}

	/** Cancel non-terminal work for retired/deleted/disabled subscribers. */
	cancelWhere(predicate: (row: Readonly<NotificationDeliveryRow>) => boolean, diagnosticCode = "SUBSCRIBER_INACTIVE"): string[] {
		const ids = Array.from(this.rows.values())
			.filter((row) => (row.state === "pending" || row.state === "leased") && predicate(row))
			.map((row) => row.deliveryId);
		if (ids.length === 0) return [];
		return this.mutateStrict(() => {
			const now = this.clock.now();
			for (const id of ids) {
				const row = this.rows.get(id)!;
				row.state = "cancelled";
				row.updatedAt = now;
				row.diagnosticCode = diagnosticCode;
				delete row.leaseId;
				delete row.leaseUntil;
			}
			return ids;
		});
	}
}

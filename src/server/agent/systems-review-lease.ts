import { randomUUID } from "node:crypto";

export class SystemsReviewWriterLeaseError extends Error {
	readonly code: "SYSTEMS_REVIEW_WRITER_LEASED" | "SYSTEMS_REVIEW_LEASE_STALE";
	readonly goalId: string;
	readonly ownerId?: string;

	constructor(code: SystemsReviewWriterLeaseError["code"], goalId: string, message: string, ownerId?: string) {
		super(message);
		this.name = "SystemsReviewWriterLeaseError";
		this.code = code;
		this.goalId = goalId;
		this.ownerId = ownerId;
	}
}

export interface SystemsReviewWriterLease {
	goalId: string;
	ownerId: string;
	token: string;
	acquiredAt: number;
	assertCurrent(): void;
	release(): void;
}

interface LeaseRecord {
	ownerId: string;
	token: string;
	acquiredAt: number;
}

/**
 * Process-wide coordinator used by the verification harness to hold the goal's
 * server-writer boundary from the first clean-worktree read through final
 * snapshot revalidation. Every server-owned goal/worktree writer must call
 * assertWriteAllowed before mutating a leased goal.
 */
export class SystemsReviewWriterLeaseCoordinator {
	private readonly leases = new Map<string, LeaseRecord>();
	private readonly now: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.now = options.now ?? (() => Date.now());
	}

	acquire(goalId: string, ownerId: string): SystemsReviewWriterLease {
		if (!goalId || !ownerId) throw new Error("Systems review writer lease requires goalId and ownerId.");
		const found = this.leases.get(goalId);
		if (found) throw new SystemsReviewWriterLeaseError("SYSTEMS_REVIEW_WRITER_LEASED", goalId, `Goal "${goalId}" is already protected by Systems review execution "${found.ownerId}".`, found.ownerId);
		const record: LeaseRecord = { ownerId, token: randomUUID(), acquiredAt: this.now() };
		this.leases.set(goalId, record);
		let released = false;
		return {
			goalId,
			ownerId,
			token: record.token,
			acquiredAt: record.acquiredAt,
			assertCurrent: () => {
				if (released || this.leases.get(goalId)?.token !== record.token) throw new SystemsReviewWriterLeaseError("SYSTEMS_REVIEW_LEASE_STALE", goalId, `Systems review writer lease for goal "${goalId}" is no longer current.`, ownerId);
			},
			release: () => {
				if (released) return;
				released = true;
				if (this.leases.get(goalId)?.token === record.token) this.leases.delete(goalId);
			},
		};
	}

	assertWriteAllowed(goalId: string, ownerToken?: string): void {
		const found = this.leases.get(goalId);
		if (!found || found.token === ownerToken) return;
		throw new SystemsReviewWriterLeaseError("SYSTEMS_REVIEW_WRITER_LEASED", goalId, `Goal "${goalId}" is immutable while Systems review execution "${found.ownerId}" is running.`, found.ownerId);
	}

	isLeased(goalId: string): boolean {
		return this.leases.has(goalId);
	}

	activeLease(goalId: string): Readonly<LeaseRecord> | undefined {
		const found = this.leases.get(goalId);
		return found ? { ...found } : undefined;
	}
}

/** Single process-wide writer boundary shared by the harness and GoalManager. */
export const systemsReviewWriterLeaseCoordinator = new SystemsReviewWriterLeaseCoordinator();

/** Central server-owned goal/worktree mutation guard. */
export function assertSystemsReviewGoalWriteAllowed(goalId: string, ownerToken?: string): void {
	systemsReviewWriterLeaseCoordinator.assertWriteAllowed(goalId, ownerToken);
}

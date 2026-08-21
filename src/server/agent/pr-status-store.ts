import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";

export interface PrStatusEntry {
	state: string;
	url?: string;
	number?: number;
	title?: string;
	reviewDecision?: string | null;
	mergeable?: string;
	viewerIsAdmin?: boolean;
	viewerCanMergeAsAdmin?: boolean;
	headRefName?: string;
	baseRefName?: string;
	updatedAt?: string;
}

export interface PrStatusChangedPayload {
	readonly goalId: string;
	readonly number?: number;
	readonly state: string;
	readonly reviewDecision?: string;
	readonly mergeability?: string;
}

/** Safe post-commit projection consumed by the host notification wiring. */
export interface PrStatusChangedFact {
	readonly goalId: string;
	readonly revision: string;
	readonly payload: Readonly<PrStatusChangedPayload>;
}

/** Thrown when the PR cache cannot be atomically published. */
export class PrStatusPersistenceError extends Error {
	readonly code = "PR_STATUS_PERSIST_FAILED";
	constructor() {
		super("Pull request status could not be published. Verify the state directory is writable and retry.");
		this.name = "PrStatusPersistenceError";
	}
}

const MAX_GOAL_ID_LENGTH = 128;
const MAX_STATUS_IDENTIFIER_LENGTH = 64;

function boundedIdentifier(value: unknown, maxLength: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength
		? value
		: undefined;
}

/** Build only the catalogue-owned public status fields; never retain cache objects. */
function safeStatusProjection(goalId: string, entry: PrStatusEntry): Readonly<PrStatusChangedPayload> | undefined {
	const safeGoalId = boundedIdentifier(goalId, MAX_GOAL_ID_LENGTH);
	const state = boundedIdentifier(entry.state, MAX_STATUS_IDENTIFIER_LENGTH);
	if (!safeGoalId || !state) return undefined;
	const number = Number.isSafeInteger(entry.number) && (entry.number as number) > 0
		? entry.number
		: undefined;
	const reviewDecision = boundedIdentifier(entry.reviewDecision, MAX_STATUS_IDENTIFIER_LENGTH);
	const mergeability = boundedIdentifier(entry.mergeable, MAX_STATUS_IDENTIFIER_LENGTH);
	return Object.freeze({
		goalId: safeGoalId,
		...(number === undefined ? {} : { number }),
		state,
		...(reviewDecision === undefined ? {} : { reviewDecision }),
		...(mergeability === undefined ? {} : { mergeability }),
	});
}

function sameSafeProjection(
	left: Readonly<PrStatusChangedPayload> | undefined,
	right: Readonly<PrStatusChangedPayload> | undefined,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function safeRevision(entry: PrStatusEntry, payload: Readonly<PrStatusChangedPayload>): string {
	// GitHub's updatedAt is an ISO timestamp. Do not let an arbitrary cache field
	// become public revision metadata when it is not a provider timestamp.
	if (typeof entry.updatedAt === "string"
		&& entry.updatedAt.length <= 64
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(entry.updatedAt)
		&& Number.isFinite(Date.parse(entry.updatedAt))) {
		return entry.updatedAt;
	}
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class PrStatusStore {
	private cache: Map<string, PrStatusEntry> = new Map();
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly fs: FsLike;

	/** Invoked after a changed safe projection is atomically committed. */
	onPullRequestStatusChanged?: (fact: PrStatusChangedFact) => void;

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.fs = fsImpl;
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "pr-status-cache.json");
		this.load();
	}

	private load(): void {
		try {
			if (this.fs.existsSync(this.storeFile)) {
				const data = JSON.parse(this.fs.readFileSync(this.storeFile, "utf-8"));
				if (data && typeof data === "object" && !Array.isArray(data)) {
					for (const [id, entry] of Object.entries(data)) {
						if (entry && typeof entry === "object") this.cache.set(id, entry as PrStatusEntry);
					}
				}
			}
		} catch (err) {
			console.error("[pr-status-store] Failed to load:", err);
		}
	}

	private existingTargetMode(): number | undefined {
		try {
			const mode = this.fs.statSync(this.storeFile).mode;
			return typeof mode === "number" ? mode & 0o777 : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
			throw error;
		}
	}

	private save(candidate: ReadonlyMap<string, PrStatusEntry>): void {
		const temp = `${this.storeFile}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const targetMode = this.existingTargetMode();
			if (!this.fs.existsSync(this.storeDir)) this.fs.mkdirSync(this.storeDir, { recursive: true });
			const bytes = JSON.stringify(Object.fromEntries(candidate), null, 2);
			this.fs.writeFileSync(temp, bytes, targetMode === undefined
				? "utf-8"
				: { encoding: "utf-8", mode: targetMode });
			this.fs.renameSync(temp, this.storeFile);
		} catch {
			try { this.fs.unlinkSync(temp); } catch { /* only clean this invocation's temp file */ }
			throw new PrStatusPersistenceError();
		}
	}

	private notify(fact: PrStatusChangedFact): void {
		try {
			this.onPullRequestStatusChanged?.(fact);
		} catch {
			// The cache is already authoritative. Observers are non-fatal and must not
			// make a successful PR status commit appear to have failed.
			console.error("[pr-status-store] Post-commit status observer failed");
		}
	}

	get(goalId: string): PrStatusEntry | undefined {
		return this.cache.get(goalId);
	}

	set(goalId: string, data: PrStatusEntry): void {
		const previous = this.cache.get(goalId);
		const committed = { ...data };
		const previousSafe = previous ? safeStatusProjection(goalId, previous) : undefined;
		const nextSafe = safeStatusProjection(goalId, committed);
		const candidate = new Map(this.cache);
		candidate.set(goalId, committed);

		this.save(candidate);
		this.cache = candidate;

		if (nextSafe && !sameSafeProjection(previousSafe, nextSafe)) {
			this.notify(Object.freeze({
				goalId,
				revision: safeRevision(committed, nextSafe),
				payload: nextSafe,
			}));
		}
	}

	getAll(): Record<string, PrStatusEntry> {
		return Object.fromEntries(this.cache);
	}

	remove(goalId: string): void {
		if (!this.cache.has(goalId)) return;
		const candidate = new Map(this.cache);
		candidate.delete(goalId);
		this.save(candidate);
		this.cache = candidate;
	}
}

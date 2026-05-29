import fs from "node:fs";
import path from "node:path";

// The shared PR walkthrough model is produced by the upstream model task. Keep this
// import pointed at that contract while retaining local structural types so this
// module can be validated independently when the shared file is not present yet.
// @ts-ignore Upstream shared model may be absent on this parallel task branch.
import type { PrWalkthroughCard as SharedPrWalkthroughCard, PrWalkthroughChangesetRef as SharedPrWalkthroughChangesetRef, WalkthroughExportCapability as SharedWalkthroughExportCapability, WalkthroughLimits as SharedWalkthroughLimits, WalkthroughWarning as SharedWalkthroughWarning } from "../../shared/pr-walkthrough/types.js";

type PreserveShared<T> = unknown extends T ? unknown : T;

type PrWalkthroughChangesetRef = {
	baseSha: string;
	headSha: string;
	provider?: string;
	externalUrl?: string;
	prUrl?: string;
	prNumber?: string | number;
	prTitle?: string;
	title?: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
} & PreserveShared<SharedPrWalkthroughChangesetRef>;

type PrWalkthroughCard = {
	id: string;
	phaseId: string;
	title: string;
	summary: string;
	diffBlocks: unknown[];
} & PreserveShared<SharedPrWalkthroughCard>;

type WalkthroughWarning = {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
} & PreserveShared<SharedWalkthroughWarning>;

type WalkthroughLimits = Record<string, unknown> & PreserveShared<SharedWalkthroughLimits>;
type WalkthroughExportCapability = Record<string, unknown> & PreserveShared<SharedWalkthroughExportCapability>;

export const WALKTHROUGH_STORE_SCHEMA_VERSION = 1;

export interface WalkthroughStorePayload {
	changesetId: string;
	changeset: PrWalkthroughChangesetRef;
	cards: PrWalkthroughCard[];
	warnings: WalkthroughWarning[];
	limits?: WalkthroughLimits;
	export?: WalkthroughExportCapability;
}

export interface StoredWalkthroughPayload extends WalkthroughStorePayload {
	schemaVersion: typeof WALKTHROUGH_STORE_SCHEMA_VERSION;
	updatedAt: string;
}

interface StoredWalkthroughFile {
	schemaVersion?: unknown;
	updatedAt?: unknown;
	changesetId?: unknown;
	changeset?: unknown;
	cards?: unknown;
	warnings?: unknown;
	limits?: unknown;
	export?: unknown;
}

const STORE_DIR = "pr-walkthrough";

export class WalkthroughStore {
	private readonly rootDir: string;

	constructor(stateDir: string) {
		this.rootDir = path.join(stateDir, STORE_DIR, `v${WALKTHROUGH_STORE_SCHEMA_VERSION}`);
	}

	save(payload: WalkthroughStorePayload): StoredWalkthroughPayload {
		const stored: StoredWalkthroughPayload = sanitizePayload({
			...payload,
			warnings: payload.warnings ?? [],
			schemaVersion: WALKTHROUGH_STORE_SCHEMA_VERSION,
			updatedAt: new Date().toISOString(),
		});
		this.ensureDir();
		fs.writeFileSync(this.filePath(payload.changesetId), `${JSON.stringify(stored, null, 2)}\n`, "utf-8");
		return stored;
	}

	get(changesetId: string): StoredWalkthroughPayload | null {
		try {
			const raw = JSON.parse(fs.readFileSync(this.filePath(changesetId), "utf-8")) as StoredWalkthroughFile;
			return parseStoredPayload(raw, changesetId);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return null;
			return null;
		}
	}

	delete(changesetId: string): boolean {
		try {
			fs.unlinkSync(this.filePath(changesetId));
			return true;
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return false;
			return false;
		}
	}

	list(): StoredWalkthroughPayload[] {
		try {
			return fs.readdirSync(this.rootDir, { withFileTypes: true })
				.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
				.map(entry => this.readFile(path.join(this.rootDir, entry.name)))
				.filter((payload): payload is StoredWalkthroughPayload => payload !== null)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return [];
			return [];
		}
	}

	private readFile(filePath: string): StoredWalkthroughPayload | null {
		try {
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StoredWalkthroughFile;
			return parseStoredPayload(raw);
		} catch {
			return null;
		}
	}

	private ensureDir(): void {
		fs.mkdirSync(this.rootDir, { recursive: true });
	}

	private filePath(changesetId: string): string {
		return path.join(this.rootDir, `${storageKeyForChangesetId(changesetId)}.json`);
	}
}

export function storageKeyForChangesetId(changesetId: string): string {
	return Buffer.from(changesetId, "utf-8").toString("base64url");
}

function parseStoredPayload(raw: StoredWalkthroughFile, expectedChangesetId?: string): StoredWalkthroughPayload | null {
	if (raw.schemaVersion !== WALKTHROUGH_STORE_SCHEMA_VERSION) return null;
	if (typeof raw.updatedAt !== "string" || typeof raw.changesetId !== "string") return null;
	if (expectedChangesetId && raw.changesetId !== expectedChangesetId) return null;
	if (!isRecord(raw.changeset) || !Array.isArray(raw.cards)) return null;
	const warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
	return sanitizePayload({
		changesetId: raw.changesetId,
		changeset: raw.changeset as PrWalkthroughChangesetRef,
		cards: raw.cards as PrWalkthroughCard[],
		warnings: warnings as WalkthroughWarning[],
		limits: isRecord(raw.limits) ? raw.limits as WalkthroughLimits : undefined,
		export: isRecord(raw.export) ? raw.export as WalkthroughExportCapability : undefined,
		schemaVersion: WALKTHROUGH_STORE_SCHEMA_VERSION,
		updatedAt: raw.updatedAt,
	});
}

function sanitizePayload(payload: StoredWalkthroughPayload): StoredWalkthroughPayload {
	const sanitized = sanitizeValue(payload) as StoredWalkthroughPayload;
	return sanitized;
}

function sanitizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => sanitizeValue(item));
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isSensitiveKey(key)) continue;
		out[key] = sanitizeValue(entry);
	}
	return out;
}

function isSensitiveKey(key: string): boolean {
	return /(^|[-_])(token|secret|authorization|auth[-_]?header|auth[-_]?headers|raw[-_]?headers|headers?)($|[-_])/i.test(key)
		|| /^(token|secret|authorization|auth|headers)$/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

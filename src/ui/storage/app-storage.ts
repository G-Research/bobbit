import type { CommandHistoryStore } from "./stores/command-history-store.js";
import type { CustomProvidersStore } from "./stores/custom-providers-store.js";
import type { PromptDraftAttachmentsStore } from "./stores/prompt-draft-attachments-store.js";
import type { ProviderKeysStore } from "./stores/provider-keys-store.js";
import type { SessionsStore } from "./stores/sessions-store.js";
import type { SettingsStore } from "./stores/settings-store.js";
import type { ShortcutBindingsStore } from "./stores/shortcut-bindings-store.js";
import type { StorageBackend, StoreConfig } from "./types.js";

const DELIVERY_INTENT_STORE = "delivery-intents";
const DELIVERY_INTENT_MAX_PER_SESSION = 50;
const DELIVERY_INTENT_MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const DELIVERY_INTENT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export interface PersistedDeliveryIntent {
	key: string;
	sessionId: string;
	intentId: string;
	frame: Record<string, unknown>;
	row: Record<string, unknown>;
	/** Monotonic local-attempt revision. Legacy records are revision zero. */
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface DeliveryIntentWriteResult {
	ok: boolean;
	revision?: number;
	reason?: "entry-too-large" | "session-full" | "storage-full" | "unavailable";
}

export interface DeliveryIntentConditionalResult {
	ok: boolean;
	applied: boolean;
	current?: PersistedDeliveryIntent;
	reason?: "entry-too-large" | "unavailable";
}

function deliveryIntentKey(sessionId: string, intentId: string): string {
	return `${sessionId}:${intentId}`;
}

function serializedBytes(value: unknown): number {
	try {
		const json = JSON.stringify(value);
		return typeof TextEncoder === "function" ? new TextEncoder().encode(json).byteLength : json.length * 2;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function normalizedRevision(record: Partial<PersistedDeliveryIntent>): number {
	return Number.isSafeInteger(record.revision) && (record.revision ?? -1) >= 0 ? record.revision! : 0;
}

/**
 * IndexedDB-backed pre-acceptance spool. Records are occurrence-keyed rather
 * than stored as one session array so two tabs cannot overwrite one another's
 * identical-text submissions. Nothing is evicted: reaching a hard bound makes
 * the new occurrence visibly fail before it can be sent.
 */
export class DeliveryIntentStore {
	constructor(private readonly backend: StorageBackend) {}

	static getConfig(): StoreConfig {
		return {
			name: DELIVERY_INTENT_STORE,
			keyPath: "key",
			indices: [
				{ name: "createdAt", keyPath: "createdAt" },
				{ name: "sessionId", keyPath: "sessionId" },
			],
		};
	}

	async list(sessionId: string): Promise<PersistedDeliveryIntent[]> {
		if (!sessionId) return [];
		try {
			const all = await this.backend.getAllFromIndex<PersistedDeliveryIntent>(
				DELIVERY_INTENT_STORE,
				"createdAt",
				"asc",
			);
			return all.filter((entry) => entry?.sessionId === sessionId && typeof entry.intentId === "string");
		} catch {
			return [];
		}
	}

	async put(
		sessionId: string,
		intentId: string,
		frame: Record<string, unknown>,
		row: Record<string, unknown>,
	): Promise<DeliveryIntentWriteResult> {
		if (!sessionId || !intentId) return { ok: false, reason: "unavailable" };
		const key = deliveryIntentKey(sessionId, intentId);
		const now = Date.now();
		const record: PersistedDeliveryIntent = {
			key,
			sessionId,
			intentId,
			frame,
			row,
			revision: 0,
			createdAt: typeof row.createdAt === "number" ? row.createdAt : now,
			updatedAt: now,
		};
		const bytes = serializedBytes(record);
		if (bytes > DELIVERY_INTENT_MAX_ENTRY_BYTES) return { ok: false, reason: "entry-too-large" };

		try {
			const existing = await this.backend.get<PersistedDeliveryIntent>(DELIVERY_INTENT_STORE, key);
			// A duplicate local admission must never overwrite a newer retry written by
			// another tab. The stable occurrence already has its durable carrier.
			if (existing) return { ok: true, revision: normalizedRevision(existing) };
			const all = await this.backend.getAllFromIndex<PersistedDeliveryIntent>(
				DELIVERY_INTENT_STORE,
				"createdAt",
				"asc",
			);
			if (all.filter((entry) => entry?.sessionId === sessionId).length >= DELIVERY_INTENT_MAX_PER_SESSION) {
				return { ok: false, reason: "session-full" };
			}
			const totalBytes = all.reduce((sum, entry) => sum + serializedBytes(entry), 0) + bytes;
			if (totalBytes > DELIVERY_INTENT_MAX_TOTAL_BYTES) return { ok: false, reason: "storage-full" };
			await this.backend.set(DELIVERY_INTENT_STORE, key, record);
			return { ok: true, revision: record.revision };
		} catch {
			return { ok: false, reason: "unavailable" };
		}
	}

	/** Atomically replace one exact rendered revision and advance it. */
	async replaceIfRevision(
		sessionId: string,
		intentId: string,
		expectedRevision: number,
		frame: Record<string, unknown>,
		row: Record<string, unknown>,
	): Promise<DeliveryIntentConditionalResult> {
		if (!sessionId || !intentId) return { ok: false, applied: false, reason: "unavailable" };
		const key = deliveryIntentKey(sessionId, intentId);
		try {
			return await this.backend.transaction([DELIVERY_INTENT_STORE], "readwrite", async (tx) => {
				const current = await tx.get<PersistedDeliveryIntent>(DELIVERY_INTENT_STORE, key);
				if (!current || normalizedRevision(current) !== expectedRevision) {
					return { ok: true, applied: false, ...(current ? { current } : {}) };
				}
				const next: PersistedDeliveryIntent = {
					...current,
					frame,
					row,
					revision: expectedRevision + 1,
					updatedAt: Date.now(),
				};
				if (serializedBytes(next) > DELIVERY_INTENT_MAX_ENTRY_BYTES) {
					return { ok: false, applied: false, current, reason: "entry-too-large" };
				}
				await tx.set(DELIVERY_INTENT_STORE, key, next);
				return { ok: true, applied: true, current: next };
			});
		} catch {
			return { ok: false, applied: false, reason: "unavailable" };
		}
	}

	/** Delete only the exact revision displayed by the calling tab. */
	async deleteIfRevision(
		sessionId: string,
		intentId: string,
		expectedRevision: number,
	): Promise<DeliveryIntentConditionalResult> {
		if (!sessionId || !intentId) return { ok: false, applied: false, reason: "unavailable" };
		const key = deliveryIntentKey(sessionId, intentId);
		try {
			return await this.backend.transaction([DELIVERY_INTENT_STORE], "readwrite", async (tx) => {
				const current = await tx.get<PersistedDeliveryIntent>(DELIVERY_INTENT_STORE, key);
				if (!current || normalizedRevision(current) !== expectedRevision) {
					return { ok: true, applied: false, ...(current ? { current } : {}) };
				}
				await tx.delete(DELIVERY_INTENT_STORE, key);
				return { ok: true, applied: true };
			});
		} catch {
			return { ok: false, applied: false, reason: "unavailable" };
		}
	}

	async delete(sessionId: string, intentId: string): Promise<void> {
		if (!sessionId || !intentId) return;
		try {
			await this.backend.delete(DELIVERY_INTENT_STORE, deliveryIntentKey(sessionId, intentId));
		} catch {
			// A reconnect resend is idempotent by intent id, so failed cleanup is safe.
		}
	}
}

/**
 * High-level storage API providing access to all storage operations.
 * Subclasses can extend this to add domain-specific stores.
 */
export class AppStorage {
	readonly backend: StorageBackend;
	readonly settings: SettingsStore;
	readonly providerKeys: ProviderKeysStore;
	readonly sessions: SessionsStore;
	readonly customProviders: CustomProvidersStore;
	readonly commandHistory: CommandHistoryStore;
	readonly shortcutBindings: ShortcutBindingsStore;
	readonly promptDraftAttachments: PromptDraftAttachmentsStore;
	readonly deliveryIntents: DeliveryIntentStore;

	constructor(
		settings: SettingsStore,
		providerKeys: ProviderKeysStore,
		sessions: SessionsStore,
		customProviders: CustomProvidersStore,
		commandHistory: CommandHistoryStore,
		shortcutBindings: ShortcutBindingsStore,
		promptDraftAttachments: PromptDraftAttachmentsStore,
		backend: StorageBackend,
	) {
		this.settings = settings;
		this.providerKeys = providerKeys;
		this.sessions = sessions;
		this.customProviders = customProviders;
		this.commandHistory = commandHistory;
		this.shortcutBindings = shortcutBindings;
		this.promptDraftAttachments = promptDraftAttachments;
		this.backend = backend;
		this.deliveryIntents = new DeliveryIntentStore(backend);
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return this.backend.getQuotaInfo();
	}

	async requestPersistence(): Promise<boolean> {
		return this.backend.requestPersistence();
	}
}

// Global instance management
let globalAppStorage: AppStorage | null = null;

/**
 * Get the global AppStorage instance.
 * Throws if not initialized.
 */
export function getAppStorage(): AppStorage {
	if (!globalAppStorage) {
		throw new Error("AppStorage not initialized. Call setAppStorage() first.");
	}
	return globalAppStorage;
}

/**
 * Set the global AppStorage instance.
 */
export function setAppStorage(storage: AppStorage): void {
	globalAppStorage = storage;
}

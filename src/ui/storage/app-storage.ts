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
	createdAt: number;
	updatedAt: number;
}

export interface DeliveryIntentWriteResult {
	ok: boolean;
	reason?: "entry-too-large" | "session-full" | "storage-full" | "unavailable";
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
			createdAt: typeof row.createdAt === "number" ? row.createdAt : now,
			updatedAt: now,
		};
		const bytes = serializedBytes(record);
		if (bytes > DELIVERY_INTENT_MAX_ENTRY_BYTES) return { ok: false, reason: "entry-too-large" };

		try {
			const existing = await this.backend.get<PersistedDeliveryIntent>(DELIVERY_INTENT_STORE, key);
			const all = await this.backend.getAllFromIndex<PersistedDeliveryIntent>(
				DELIVERY_INTENT_STORE,
				"createdAt",
				"asc",
			);
			if (!existing && all.filter((entry) => entry?.sessionId === sessionId).length >= DELIVERY_INTENT_MAX_PER_SESSION) {
				return { ok: false, reason: "session-full" };
			}
			const totalBytes = all.reduce((sum, entry) => sum + serializedBytes(entry), 0)
				- (existing ? serializedBytes(existing) : 0)
				+ bytes;
			if (totalBytes > DELIVERY_INTENT_MAX_TOTAL_BYTES) return { ok: false, reason: "storage-full" };
			await this.backend.set(DELIVERY_INTENT_STORE, key, record);
			return { ok: true };
		} catch {
			return { ok: false, reason: "unavailable" };
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

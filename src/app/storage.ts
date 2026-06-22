import { AppStorage, setAppStorage } from "../ui/storage/app-storage.js";
import { IndexedDBStorageBackend } from "../ui/storage/backends/indexeddb-storage-backend.js";
import { CommandHistoryStore } from "../ui/storage/stores/command-history-store.js";
import { CustomProvidersStore } from "../ui/storage/stores/custom-providers-store.js";
import { PromptDraftAttachmentsStore } from "../ui/storage/stores/prompt-draft-attachments-store.js";
import { ProviderKeysStore } from "../ui/storage/stores/provider-keys-store.js";
import { SessionsStore } from "../ui/storage/stores/sessions-store.js";
import { SettingsStore } from "../ui/storage/stores/settings-store.js";
import { ShortcutBindingsStore } from "../ui/storage/stores/shortcut-bindings-store.js";

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const commandHistory = new CommandHistoryStore();
const shortcutBindings = new ShortcutBindingsStore();
const promptDraftAttachments = new PromptDraftAttachmentsStore();

const backend = new IndexedDBStorageBackend({
	dbName: "pi-gateway-ui",
	version: 7,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
		commandHistory.getConfig(),
		shortcutBindings.getConfig(),
		promptDraftAttachments.getConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);
commandHistory.setBackend(backend);
shortcutBindings.setBackend(backend);
promptDraftAttachments.setBackend(backend);

export const storage = new AppStorage(settings, providerKeys, sessions, customProviders, commandHistory, shortcutBindings, promptDraftAttachments, backend);
setAppStorage(storage);

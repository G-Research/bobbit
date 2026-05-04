// Direct imports (not via ../ui/index.js barrel) so the bootstrap chunk
// does not pull in heavy custom-element side-effects from sibling exports.
import { AppStorage, setAppStorage } from "../ui/storage/app-storage.js";
import { IndexedDBStorageBackend } from "../ui/storage/backends/indexeddb-storage-backend.js";
import { CustomProvidersStore } from "../ui/storage/stores/custom-providers-store.js";
import { ProviderKeysStore } from "../ui/storage/stores/provider-keys-store.js";
import { SessionsStore } from "../ui/storage/stores/sessions-store.js";
import { SettingsStore } from "../ui/storage/stores/settings-store.js";
import { ShortcutBindingsStore } from "../ui/storage/stores/shortcut-bindings-store.js";
import { CommandHistoryStore } from "../ui/storage/stores/command-history-store.js";

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const commandHistory = new CommandHistoryStore();
const shortcutBindings = new ShortcutBindingsStore();

const backend = new IndexedDBStorageBackend({
	dbName: "pi-gateway-ui",
	version: 6,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
		commandHistory.getConfig(),
		shortcutBindings.getConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);
commandHistory.setBackend(backend);
shortcutBindings.setBackend(backend);

export const storage = new AppStorage(settings, providerKeys, sessions, customProviders, commandHistory, shortcutBindings, backend);
setAppStorage(storage);

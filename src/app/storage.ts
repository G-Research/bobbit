import {
	AppStorage,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	ShortcutBindingsStore,
	setAppStorage,
} from "../ui/index.js";
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

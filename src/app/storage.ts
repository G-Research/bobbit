import {
	AppStorage,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "../ui/index.js";
import { CommandHistoryStore } from "../ui/storage/stores/command-history-store.js";

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const commandHistory = new CommandHistoryStore();

const backend = new IndexedDBStorageBackend({
	dbName: "pi-gateway-ui",
	version: 5,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
		commandHistory.getConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);
commandHistory.setBackend(backend);

export const storage = new AppStorage(settings, providerKeys, sessions, customProviders, commandHistory, backend);
setAppStorage(storage);

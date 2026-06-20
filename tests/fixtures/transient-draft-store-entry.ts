// Test entry — bundles the real TransientDraftStore so we can exercise it
// against the browser's actual sessionStorage / localStorage in a file://
// fixture. No DOM/lit dependency: this is a pure synchronous storage module.
import {
	createTransientDraftStore,
	type TransientDraftStoreOptions,
} from "../../src/ui/storage/transient-draft-store.js";

const w = window as any;

w.__createStore = (options: TransientDraftStoreOptions) => createTransientDraftStore(options);

// Raw inspection helpers — read the underlying storage record verbatim.
w.__rawSession = (storageKey: string) => window.sessionStorage.getItem(storageKey);
w.__rawLocal = (storageKey: string) => window.localStorage.getItem(storageKey);

w.__listKeys = (backend: "session" | "local", prefix: string) => {
	const storage = backend === "local" ? window.localStorage : window.sessionStorage;
	const out: string[] = [];
	for (let i = 0; i < storage.length; i++) {
		const k = storage.key(i);
		if (k != null && k.startsWith(prefix)) out.push(k);
	}
	return out;
};

w.__clearAll = () => {
	try { window.sessionStorage.clear(); } catch { /* ignore */ }
	try { window.localStorage.clear(); } catch { /* ignore */ }
};

// Install / restore throwing Storage methods to simulate disabled/quota storage.
let _origSetItem: typeof Storage.prototype.setItem | null = null;
let _origGetItem: typeof Storage.prototype.getItem | null = null;
w.__breakStorage = () => {
	if (_origSetItem) return;
	_origSetItem = Storage.prototype.setItem;
	_origGetItem = Storage.prototype.getItem;
	Storage.prototype.setItem = function () { throw new Error("QuotaExceededError (simulated)"); };
	Storage.prototype.getItem = function () { throw new Error("SecurityError (simulated)"); };
};
w.__restoreStorage = () => {
	if (_origSetItem) { Storage.prototype.setItem = _origSetItem; _origSetItem = null; }
	if (_origGetItem) { Storage.prototype.getItem = _origGetItem; _origGetItem = null; }
};

w.__ready = true;

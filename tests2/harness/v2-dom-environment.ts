// v2-dom only: Node may expose an unusable `localStorage` global which
// happy-dom leaves in place instead of replacing with the window's storage.
// Install the current file's real window stores after happy-dom has created it.
import { afterAll, afterEach, beforeEach } from "vitest";

type StorageProperty = "localStorage" | "sessionStorage";
type DescriptorPair = Record<StorageProperty, PropertyDescriptor | undefined>;
type StorageDescriptors = { global: DescriptorPair; window: DescriptorPair };

let previousDescriptors: StorageDescriptors | undefined;

function windowStorage(name: StorageProperty): Storage {
	// `window` is one of happy-dom's copied globals and can retain Node's
	// unavailable property. The document's defaultView is the actual per-file
	// happy-dom Window and owns the real Storage implementation.
	const currentWindow = globalThis.document?.defaultView;
	if (!currentWindow) throw new Error(`v2-dom setup requires a document window for ${name}`);
	const store = currentWindow[name];
	// Node's unavailable localStorage can overwrite happy-dom's populated
	// window property too. Construct through this file's Window so the fallback
	// remains the environment's real Storage implementation rather than a fake.
	return store ?? new currentWindow.Storage();
}

/** Install storage from the current happy-dom window (never a module-scoped window). */
export function installDomStorage(): StorageDescriptors {
	const currentWindow = globalThis.document?.defaultView;
	if (!currentWindow) throw new Error("v2-dom setup requires a document window");
	const previous: StorageDescriptors = {
		global: {
			localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
			sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
		},
		window: {
			localStorage: Object.getOwnPropertyDescriptor(currentWindow, "localStorage"),
			sessionStorage: Object.getOwnPropertyDescriptor(currentWindow, "sessionStorage"),
		},
	};
	for (const name of ["localStorage", "sessionStorage"] as const) {
		const store = windowStorage(name);
		const descriptor = { value: store, writable: true, configurable: true };
		// Vitest's global and happy-dom's Window are distinct aliases. Patch both
		// so application code and fixtures always operate on the same live store.
		Object.defineProperty(currentWindow, name, descriptor);
		Object.defineProperty(globalThis, name, descriptor);
	}
	return previous;
}

export function restoreDomStorage(previous: StorageDescriptors): void {
	const currentWindow = globalThis.document?.defaultView;
	for (const name of ["localStorage", "sessionStorage"] as const) {
		(globalThis as typeof globalThis)[name]?.clear();
		if (previous.global[name]) Object.defineProperty(globalThis, name, previous.global[name]);
		else Reflect.deleteProperty(globalThis, name);
		if (!currentWindow) continue;
		if (previous.window[name]) Object.defineProperty(currentWindow, name, previous.window[name]);
		else Reflect.deleteProperty(currentWindow, name);
	}
}

// Some existing DOM fixtures initialize browser-backed state in beforeAll.
// Install once at setup evaluation (after happy-dom created this file's window),
// then still re-install and reset around every individual test.
const environmentDescriptors = installDomStorage();

beforeEach(() => {
	previousDescriptors = installDomStorage();
});

afterEach(() => {
	if (previousDescriptors) restoreDomStorage(previousDescriptors);
	previousDescriptors = undefined;
});

afterAll(() => restoreDomStorage(environmentDescriptors));

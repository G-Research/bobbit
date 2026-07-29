// v2-dom only: Node may expose an unusable `localStorage` global which
// happy-dom leaves in place instead of replacing with the window's storage.
// Install the current file's real window stores after happy-dom has created it.
import { Storage } from "happy-dom";
import { afterAll, afterEach, beforeEach } from "vitest";

type StorageProperty = "localStorage" | "sessionStorage";
type DescriptorPair = Record<StorageProperty, PropertyDescriptor | undefined>;

let previousDescriptors: DescriptorPair | undefined;

function windowStorage(name: StorageProperty): Storage {
	// `window` is one of happy-dom's copied globals and can retain Node's
	// unavailable property. The document's defaultView is the actual per-file
	// happy-dom Window and owns the real Storage implementation.
	const currentWindow = globalThis.document?.defaultView;
	if (!currentWindow) throw new Error(`v2-dom setup requires a document window for ${name}`);
	const store = currentWindow[name];
	// Node's unavailable localStorage can overwrite happy-dom's populated
	// window property too. Use happy-dom's real Storage implementation, not a
	// hand-rolled map, when that happens.
	return store ?? new Storage();
}

/** Install storage from the current happy-dom window (never a module-scoped window). */
export function installDomStorage(): DescriptorPair {
	const previous: DescriptorPair = {
		localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
		sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
	};
	for (const name of ["localStorage", "sessionStorage"] as const) {
		Object.defineProperty(globalThis, name, {
			value: windowStorage(name),
			writable: true,
			configurable: true,
		});
	}
	return previous;
}

export function restoreDomStorage(previous: DescriptorPair): void {
	for (const name of ["localStorage", "sessionStorage"] as const) {
		const store = (globalThis as typeof globalThis)[name];
		store?.clear();
		if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
		else delete (globalThis as Record<string, unknown>)[name];
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

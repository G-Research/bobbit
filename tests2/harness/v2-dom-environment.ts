// v2-dom only: Node 26 may expose an unusable `localStorage` global which
// Vitest does not replace with happy-dom's storage. Source the real per-file
// BrowserWindow through the document's happy-dom owner symbol: Vitest rewrites
// document.defaultView, window, and self to the Node global.
import { PropertySymbol } from "happy-dom";
import { afterAll, afterEach, beforeEach } from "vitest";

type StorageProperty = "localStorage" | "sessionStorage";
type DescriptorPair = Record<StorageProperty, PropertyDescriptor | undefined>;
type HappyDomWindow = Record<StorageProperty, Storage>;
type StorageDescriptors = { global: DescriptorPair; stores: Record<StorageProperty, Storage> };

let previousDescriptors: StorageDescriptors | undefined;

function happyDomWindow(): HappyDomWindow {
	const documentWindow = (globalThis.document as unknown as Record<PropertyKey, unknown>)[PropertySymbol.window];
	if (!documentWindow || documentWindow === globalThis) {
		throw new Error("v2-dom setup requires happy-dom's per-file BrowserWindow");
	}
	return documentWindow as HappyDomWindow;
}

/**
 * Install the current file's real happy-dom stores without reading the runtime
 * global. Vitest intentionally aliases `document.defaultView` to globalThis,
 * which is where Node 26's unavailable storage accessor lives.
 */
export function installDomStorage(): StorageDescriptors {
	const sourceWindow = happyDomWindow();
	const stores = {
		localStorage: sourceWindow.localStorage,
		sessionStorage: sourceWindow.sessionStorage,
	};
	const previous: StorageDescriptors = {
		global: {
			localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
			sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
		},
		stores,
	};
	for (const name of ["localStorage", "sessionStorage"] as const) {
		Object.defineProperty(globalThis, name, {
			value: stores[name],
			writable: true,
			configurable: true,
		});
	}
	return previous;
}

export function restoreDomStorage(previous: StorageDescriptors): void {
	for (const name of ["localStorage", "sessionStorage"] as const) {
		previous.stores[name].clear();
		if (previous.global[name]) Object.defineProperty(globalThis, name, previous.global[name]);
		else Reflect.deleteProperty(globalThis, name);
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

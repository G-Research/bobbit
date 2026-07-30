import { afterEach, expect, it, vi } from "vitest";
import { PropertySymbol } from "happy-dom";
import { gatewayFetch } from "../../src/app/gateway-fetch.js";
import { installDomStorage, restoreDomStorage } from "../harness/v2-dom-environment.js";

type StorageProperty = "localStorage" | "sessionStorage";

function restoreGlobalStorage(descriptors: Record<StorageProperty, PropertyDescriptor | undefined>) {
	for (const name of ["localStorage", "sessionStorage"] as const) {
		if (descriptors[name]) Object.defineProperty(globalThis, name, descriptors[name]);
		else Reflect.deleteProperty(globalThis, name);
	}
}

function globalStorageDescriptors(): Record<StorageProperty, PropertyDescriptor | undefined> {
	return {
		localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
		sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
	};
}

afterEach(() => vi.unstubAllGlobals());

it("installs the current happy-dom storage when a runtime global is absent", async () => {
	const configuredDescriptors = globalStorageDescriptors();
	for (const name of ["localStorage", "sessionStorage"] as const) Reflect.deleteProperty(globalThis, name);
	expect(globalThis.localStorage).toBeUndefined();
	expect(globalThis.sessionStorage).toBeUndefined();

	const absentDescriptors = installDomStorage();
	const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetch);
	try {
		globalThis.localStorage.setItem("gateway.token", "test-token");
		await gatewayFetch("/api/storage-regression");
		expect(fetch).toHaveBeenCalledWith(
			`${window.location.origin}/api/storage-regression`,
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
		);
	} finally {
		restoreDomStorage(absentDescriptors);
		restoreGlobalStorage(configuredDescriptors);
	}
});

it("uses the owning happy-dom Window rather than rewritten document.defaultView", () => {
	const configuredDescriptors = globalStorageDescriptors();
	const unavailable = new Error("Node storage is unavailable");
	try {
		// Vitest's populateGlobal makes this alias Node's global object, not the
		// BrowserWindow that owns the actual happy-dom Storage instances.
		expect(document.defaultView).toBe(globalThis);
		for (const name of ["localStorage", "sessionStorage"] as const) {
			Object.defineProperty(globalThis, name, {
				get: () => { throw unavailable; },
				configurable: true,
			});
		}

		let previous: ReturnType<typeof installDomStorage> | undefined;
		expect(() => { previous = installDomStorage(); }).not.toThrow();
		const browserWindow = (document as unknown as Record<PropertyKey, Record<StorageProperty, Storage>>)[PropertySymbol.window];
		try {
			for (const name of ["localStorage", "sessionStorage"] as const) {
				expect(globalThis[name]).toBe(browserWindow[name]);
				globalThis[name].setItem(`${name}-key`, "value");
				expect(browserWindow[name].getItem(`${name}-key`)).toBe("value");
			}
		} finally {
			if (previous) restoreDomStorage(previous);
		}
	} finally {
		restoreGlobalStorage(configuredDescriptors);
	}
});

it("replaces pre-owned runtime stores and restores their exact descriptors", () => {
	const configuredDescriptors = globalStorageDescriptors();
	const preOwned = {
		localStorage: { clear: vi.fn() } as unknown as Storage,
		sessionStorage: { clear: vi.fn() } as unknown as Storage,
	};
	try {
		for (const name of ["localStorage", "sessionStorage"] as const) {
			Object.defineProperty(globalThis, name, {
				value: preOwned[name],
				configurable: true,
			});
		}
		const preOwnedDescriptors = globalStorageDescriptors();
		const previous = installDomStorage();
		try {
			for (const name of ["localStorage", "sessionStorage"] as const) {
				expect(globalThis[name]).not.toBe(preOwned[name]);
				expect(typeof globalThis[name].getItem).toBe("function");
			}
		} finally {
			restoreDomStorage(previous);
		}
		for (const name of ["localStorage", "sessionStorage"] as const) {
			expect(globalThis[name]).toBe(preOwned[name]);
			expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(preOwnedDescriptors[name]);
		}
	} finally {
		restoreGlobalStorage(configuredDescriptors);
	}
});

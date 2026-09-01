import { afterEach, expect, it, vi } from "vitest";
import { PropertySymbol } from "happy-dom";
import {
	__resetGatewayConnectionForTests,
	gatewayFetch,
} from "../../src/app/gateway-fetch.js";
import { installDomStorage, restoreDomStorage } from "../../tests/support/harnesses/unit/v2-dom-environment.js";

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

afterEach(() => {
	__resetGatewayConnectionForTests();
	vi.unstubAllGlobals();
});

it("installs the current happy-dom storage when a runtime global is absent", async () => {
	const configuredDescriptors = globalStorageDescriptors();
	for (const name of ["localStorage", "sessionStorage"] as const) Reflect.deleteProperty(globalThis, name);
	expect(globalThis.localStorage).toBeUndefined();
	expect(globalThis.sessionStorage).toBeUndefined();

	const absentDescriptors = installDomStorage();
	const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetch);
	try {
		const gatewayBaseUrl = `${window.location.origin}/team/bobbit`;
		globalThis.localStorage.setItem("gateway.url", gatewayBaseUrl);
		globalThis.localStorage.setItem("gateway.token", "test-token");
		__resetGatewayConnectionForTests();
		await gatewayFetch("/api/storage-regression");

		expect(fetch).toHaveBeenCalledTimes(1);
		const [requestUrl, requestInit] = fetch.mock.calls[0]!;
		expect(requestUrl).toBe(`${gatewayBaseUrl}/api/storage-regression`);
		const requestHeaders = new Headers(requestInit?.headers);
		expect(requestHeaders.get("Authorization")).toBe("Bearer test-token");
	} finally {
		__resetGatewayConnectionForTests();
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

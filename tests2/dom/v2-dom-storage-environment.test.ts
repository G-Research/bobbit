import { afterEach, expect, it, vi } from "vitest";
import { gatewayFetch } from "../../src/app/gateway-fetch.js";
import { installDomStorage, restoreDomStorage } from "../harness/v2-dom-environment.js";

afterEach(() => vi.unstubAllGlobals());

it("installs the current happy-dom storage when a runtime global is absent", async () => {
	const configuredDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	delete (globalThis as Record<string, unknown>).localStorage;
	expect(globalThis.localStorage).toBeUndefined();

	const absentDescriptor = installDomStorage();
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
		restoreDomStorage(absentDescriptor);
		if (configuredDescriptor) Object.defineProperty(globalThis, "localStorage", configuredDescriptor);
	}
});

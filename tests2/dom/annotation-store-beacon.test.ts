import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	__resetGatewayConnectionForTests,
	commitGatewayConnection,
	LOCALHOST_TOKEN,
} from "../../src/app/gateway-fetch.js";
import {
	addAnnotation,
	clearAllAnnotations,
} from "../../src/ui/components/review/AnnotationStore.js";

const REMOTE_SESSION = "remote-session";
const SENTINEL_SESSION = "sentinel-session";

let sendBeacon: ReturnType<typeof vi.fn>;

beforeEach(() => {
	(window as typeof window & { happyDOM?: { setURL(url: string): void } }).happyDOM?.setURL("https://ui.example/");
	localStorage.clear();
	__resetGatewayConnectionForTests();
	vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})));
	sendBeacon = vi.fn(() => true);
	Object.defineProperty(navigator, "sendBeacon", {
		configurable: true,
		value: sendBeacon,
	});
});

afterEach(async () => {
	await Promise.all([
		clearAllAnnotations(REMOTE_SESSION),
		clearAllAnnotations(SENTINEL_SESSION),
	]);
	__resetGatewayConnectionForTests();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("AnnotationStore unload beacon", () => {
	it("preserves an explicit remote gateway prefix and authenticates with only the active real token", async () => {
		commitGatewayConnection("https://gateway.example/team/bobbit", "real-token/with space");
		await addAnnotation(REMOTE_SESSION, "Review", {
			id: "annotation-1",
			quote: "selected text",
			comment: "comment",
		});
		sendBeacon.mockClear();

		const storageRead = vi.spyOn(localStorage, "getItem");
		window.dispatchEvent(new Event("beforeunload"));

		expect(sendBeacon).toHaveBeenCalledTimes(1);
		expect(String(sendBeacon.mock.calls[0]?.[0])).toBe(
			"https://gateway.example/team/bobbit/api/sessions/remote-session/review/annotations/bulk?token=real-token%2Fwith%20space",
		);
		expect(sendBeacon.mock.calls[0]?.[1]).toBeInstanceOf(Blob);
		expect(storageRead).not.toHaveBeenCalled();
	});

	it("keeps the selected mount but never sends the localhost sentinel", async () => {
		commitGatewayConnection("https://ui.example/team/bobbit", LOCALHOST_TOKEN);
		await addAnnotation(SENTINEL_SESSION, "Review", {
			id: "annotation-2",
			quote: "selected text",
			comment: "comment",
		});
		sendBeacon.mockClear();

		window.dispatchEvent(new Event("beforeunload"));

		expect(sendBeacon).toHaveBeenCalledTimes(1);
		const url = String(sendBeacon.mock.calls[0]?.[0]);
		expect(url).toBe(
			"https://ui.example/team/bobbit/api/sessions/sentinel-session/review/annotations/bulk",
		);
		expect(new URL(url).searchParams.has("token")).toBe(false);
	});
});

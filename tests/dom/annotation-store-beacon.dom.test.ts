import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	__resetGatewayConnectionForTests,
	commitGatewayConnection,
	LOCALHOST_TOKEN,
} from "../../src/app/gateway-fetch.js";
import {
	addAnnotation,
	clearAllAnnotations,
	clearReviewTombstone,
	getReviewTombstone,
	isReviewSubmitted,
	setReviewTombstone,
} from "../../src/ui/components/review/AnnotationStore.js";

const MOUNTED_SESSION = "mounted-session";
const REMOTE_SESSION = "remote-session";
const SENTINEL_SESSION = "sentinel-session";

let fetchMock: ReturnType<typeof vi.fn>;
let sendBeacon: ReturnType<typeof vi.fn>;

beforeEach(() => {
	(window as typeof window & { happyDOM?: { setURL(url: string): void } }).happyDOM?.setURL("https://ui.example/");
	localStorage.clear();
	__resetGatewayConnectionForTests();
	fetchMock = vi.fn(async () => new Response("{}", {
		status: 200,
		headers: { "Content-Type": "application/json" },
	}));
	vi.stubGlobal("fetch", fetchMock);
	sendBeacon = vi.fn(() => true);
	Object.defineProperty(navigator, "sendBeacon", {
		configurable: true,
		value: sendBeacon,
	});
});

afterEach(async () => {
	await Promise.all([
		clearAllAnnotations(MOUNTED_SESSION),
		clearAllAnnotations(REMOTE_SESSION),
		clearAllAnnotations(SENTINEL_SESSION),
	]);
	__resetGatewayConnectionForTests();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("AnnotationStore per-review tombstones", () => {
	it("persists and clears exact review identities without mutating siblings", async () => {
		commitGatewayConnection("https://ui.example/team/bobbit", "real-token");
		await setReviewTombstone(MOUNTED_SESSION, "review/a", "submitted");
		await setReviewTombstone(MOUNTED_SESSION, "review-b", "closed");

		expect(isReviewSubmitted(MOUNTED_SESSION, "review/a")).toBe(true);
		expect(getReviewTombstone(MOUNTED_SESSION, "review-b")).toBe("closed");
		expect(fetchMock.mock.calls.slice(0, 2).map((call) => [call[0], call[1]?.method])).toEqual([
			["https://ui.example/team/bobbit/api/sessions/mounted-session/review/tombstones/review%2Fa", "PUT"],
			["https://ui.example/team/bobbit/api/sessions/mounted-session/review/tombstones/review-b", "PUT"],
		]);

		await clearReviewTombstone(MOUNTED_SESSION, "review/a");
		expect(getReviewTombstone(MOUNTED_SESSION, "review/a")).toBeUndefined();
		expect(getReviewTombstone(MOUNTED_SESSION, "review-b")).toBe("closed");
		expect(fetchMock.mock.calls[2]?.[0]).toBe(
			"https://ui.example/team/bobbit/api/sessions/mounted-session/review/tombstones/review%2Fa",
		);
		expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("DELETE");

		await clearReviewTombstone(MOUNTED_SESSION, "review-b");
	});
});

describe("AnnotationStore unload beacon", () => {
	it("preserves an exact-origin gateway prefix without putting its real token in the URL", async () => {
		commitGatewayConnection("https://ui.example/team/bobbit", "real-token/with space");
		await addAnnotation(MOUNTED_SESSION, "Review", {
			id: "annotation-1",
			quote: "selected text",
			comment: "comment",
		});
		sendBeacon.mockClear();

		const storageRead = vi.spyOn(localStorage, "getItem");
		window.dispatchEvent(new Event("beforeunload"));

		expect(sendBeacon).toHaveBeenCalledTimes(1);
		const url = String(sendBeacon.mock.calls[0]?.[0]);
		expect(url).toBe(
			"https://ui.example/team/bobbit/api/sessions/mounted-session/review/annotations/bulk",
		);
		expect(new URL(url).searchParams.has("token")).toBe(false);
		expect(sendBeacon.mock.calls[0]?.[1]).toBeInstanceOf(Blob);
		expect(storageRead).not.toHaveBeenCalled();
	});

	it("skips the unload-only beacon for an explicit cross-origin gateway", async () => {
		commitGatewayConnection("https://gateway.example/team/bobbit", "real-token");
		await addAnnotation(REMOTE_SESSION, "Review", {
			id: "annotation-2",
			quote: "selected text",
			comment: "comment",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://gateway.example/team/bobbit/api/sessions/remote-session/review/annotations",
		);
		expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer real-token");
		sendBeacon.mockClear();

		window.dispatchEvent(new Event("beforeunload"));

		expect(sendBeacon).not.toHaveBeenCalled();
	});

	it("keeps the selected mount but never sends the localhost sentinel", async () => {
		commitGatewayConnection("https://ui.example/team/bobbit", LOCALHOST_TOKEN);
		await addAnnotation(SENTINEL_SESSION, "Review", {
			id: "annotation-3",
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

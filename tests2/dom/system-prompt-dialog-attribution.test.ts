import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let SystemPromptDialog: typeof import("../../src/ui/dialogs/SystemPromptDialog.js").SystemPromptDialog;

type Entry = Record<string, unknown>;

let entries: Entry[] = [];
let requestedAttributionUrls: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (character: string) => character.repeat(64);

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function attribution(overrides: Entry = {}): Entry {
	return {
		ts: Date.UTC(2026, 7, 5, 12, 0, 0),
		sequence: 7,
		comparison: "stable",
		comparableTo: 6,
		providerCacheTelemetry: "unknown",
		components: [
			{ kind: "system", sha256: digest("a"), bytes: 101 },
			{ kind: "tools", sha256: digest("b"), bytes: 202 },
			{ kind: "dynamic-context", sha256: digest("c"), bytes: 303 },
			{ kind: "skills", sha256: digest("d"), bytes: 404 },
		],
		...overrides,
	};
}

function installFetchMock(): void {
	vi.stubGlobal("fetch", async (input: string | URL | Request) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, "https://fixture.local");
		if (url.pathname.endsWith("/prompt-sections")) {
			return response({ sections: [{ label: "Core", source: "fixture", content: "Visible prompt section", tokens: 10 }], totalTokens: 10 });
		}
		if (url.pathname.endsWith("/prompt-prefix-attribution")) {
			requestedAttributionUrls.push(url.href);
			return response({ entries });
		}
		return new Response("Not found", { status: 404 });
	});
}

async function openInspector(): Promise<HTMLElement> {
	SystemPromptDialog.show("attribution-session");
	const dialog = document.querySelector("system-prompt-dialog") as HTMLElement & { updateComplete: Promise<void> };
	for (let attempt = 0; attempt < 50; attempt++) {
		await dialog.updateComplete;
		if (dialog.querySelector('[data-testid="prompt-prefix-attribution-status"]')) return dialog;
		await sleep(5);
	}
	throw new Error("Prompt-prefix attribution did not render");
}

beforeAll(async () => {
	localStorage.setItem("gateway.url", "https://fixture.local");
	localStorage.setItem("gateway.token", "fixture-token");
	({ SystemPromptDialog } = await import("../../src/ui/dialogs/SystemPromptDialog.js"));
	__syncCE();
	await customElements.whenDefined("system-prompt-dialog");
});

beforeEach(() => {
	entries = [attribution()];
	requestedAttributionUrls = [];
	installFetchMock();
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("SystemPromptDialog prompt-prefix attribution", () => {
	it("fetches hash-only attribution alongside prompt sections and exposes only approved fingerprint metadata", async () => {
		entries = [attribution({ diagnosticContent: "ATTRIBUTION_SECRET_MUST_NOT_RENDER" })];
		const dialog = await openInspector();

		expect(requestedAttributionUrls).toHaveLength(1);
		expect(new URL(requestedAttributionUrls[0]).searchParams.get("limit")).toBe("20");
		expect(dialog.querySelector('[data-testid="prompt-prefix-attribution-status"]')?.textContent).toContain("Stable prefix");
		expect(dialog.querySelector('[data-testid="prompt-prefix-cache-status"]')?.textContent).toBe("Provider cache: unknown");
		expect(dialog.querySelector('[data-testid="prompt-prefix-attribution-details"] summary')?.textContent).toBe("Fingerprint details");
		expect(dialog.querySelector('[data-component="tools"]')?.textContent).toContain(`${digest("b").slice(0, 12)} · 202 bytes`);
		expect(dialog.textContent).toContain("Sequence");
		expect(dialog.textContent).toContain("2026-08-05T12:00:00.000Z");
		expect(dialog.textContent).not.toContain(digest("b"));
		expect(dialog.textContent).not.toContain("ATTRIBUTION_SECRET_MUST_NOT_RENDER");
	});

	it.each([
		["system", "System prompt"],
		["tools", "Tools"],
		["dynamic-context", "Dynamic context"],
		["skills", "Skills"],
	] as const)("names the %s culprit", async (culprit, label) => {
		entries = [attribution({ comparison: "changed", culprit, changed: [culprit] })];
		const dialog = await openInspector();
		expect(dialog.querySelector('[data-testid="prompt-prefix-attribution-status"]')?.textContent).toContain(`Prefix changed: ${label}`);
	});

	it("distinguishes multiple, first, unattributable, model, and compaction states", async () => {
		const cases: Array<[Entry, string]> = [
			[attribution({ comparison: "changed", culprit: "multiple", changed: ["tools", "skills"] }), "Prefix changed: multiple components"],
			[attribution({ comparison: "first" }), "Prefix baseline: first request"],
			[attribution({ comparison: "changed", culprit: "unattributable" }), "Prefix changed: unattributable"],
			[attribution({ comparison: "boundary", boundaryReason: "model-switch" }), "Prefix baseline changed at model switch"],
			[attribution({ comparison: "boundary", boundaryReason: "compaction" }), "Prefix baseline changed after compaction"],
		];

		for (const [entry, expected] of cases) {
			document.body.innerHTML = "";
			entries = [entry];
			const dialog = await openInspector();
			expect(dialog.querySelector('[data-testid="prompt-prefix-attribution-status"]')?.textContent).toContain(expected);
		}
	});

	it("refetches the latest persisted result when the inspector is reopened after reload", async () => {
		const first = await openInspector();
		expect(first.querySelector('[data-testid="prompt-prefix-attribution-status"]')?.textContent).toContain("Stable prefix");
		first.remove();

		entries = [attribution({ comparison: "changed", culprit: "tools", changed: ["tools"], sequence: 8, comparableTo: 7 })];
		const reopened = await openInspector();
		expect(reopened.querySelector('[data-testid="prompt-prefix-attribution-status"]')?.textContent).toContain("Prefix changed: Tools");
		expect(requestedAttributionUrls).toHaveLength(2);
	});
});

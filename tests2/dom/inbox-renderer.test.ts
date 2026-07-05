// Migrated from tests/inbox-renderer.spec.ts (v2-dom tier).
// Renders the REAL inbox tool renderers (InboxListRenderer / InboxCompleteRenderer
// / InboxDismissRenderer) via lit into happy-dom light-DOM containers, replacing
// the esbuild file:// bundle. Pins the same streaming / empty / success / error
// output invariants the legacy spec asserted.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import {
	InboxListRenderer,
	InboxCompleteRenderer,
	InboxDismissRenderer,
} from "../../src/ui/tools/renderers/InboxToolRenderers.js";

type Kind = "list" | "complete" | "dismiss";

function makeRenderer(kind: Kind) {
	if (kind === "list") return new InboxListRenderer();
	if (kind === "complete") return new InboxCompleteRenderer();
	return new InboxDismissRenderer();
}

function jsonResult(data: any, isError = false) {
	return {
		isError,
		content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
	} as any;
}

function renderInbox(kind: Kind, params: any, result: any = undefined, isStreaming = false): HTMLElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const out = makeRenderer(kind).render(params, result, isStreaming);
	render(out.content, container);
	return container;
}

const text = (el: HTMLElement) => (el.textContent || "").replace(/\s+/g, " ").trim();

afterEach(() => { document.body.innerHTML = ""; });

const SAMPLE_ENTRIES = [
	{
		id: "8af3b1c2-aaaa-bbbb-cccc-1234567890ab",
		staffId: "staff1",
		source: { type: "trigger", triggerId: "cron-1" },
		title: "Daily standup digest",
		prompt: "Summarize PRs and post to #standup.",
		state: "pending",
		createdAt: Date.now() - 2 * 60 * 1000,
	},
	{
		id: "3df9aa01-aaaa-bbbb-cccc-1234567890ab",
		staffId: "staff1",
		source: { type: "manual_ui", actorId: "user1" },
		title: "Investigate flaky test",
		prompt: "browser-eval.spec.ts is flaky.",
		state: "pending",
		createdAt: Date.now() - 28 * 60 * 1000,
	},
	{
		id: "19c8b773-aaaa-bbbb-cccc-1234567890ab",
		staffId: "staff1",
		source: { type: "manual_api", actorId: "github-webhook" },
		title: "Process webhook from GitHub",
		prompt: "PR #4821 merged.",
		state: "failed",
		createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
		error: "External API returned 503.",
	},
];

describe("InboxListRenderer", () => {
	it("streaming state shows in-progress header", () => {
		const el = renderInbox("list", {}, undefined, true);
		expect(text(el)).toMatch(/Listing inbox/i);
	});

	it("empty result shows zero-entries header", () => {
		const el = renderInbox("list", { state: "pending" }, jsonResult({ entries: [] }), false);
		expect(text(el)).toMatch(/No pending entries/i);
	});

	it("entries render with state badge, title, age and 8-char id chip", () => {
		const el = renderInbox("list", {}, jsonResult({ entries: SAMPLE_ENTRIES }), false);

		// Header has total count + state breakdown.
		expect(text(el)).toMatch(/3 inbox entries/);
		expect(text(el)).toMatch(/2 pending/);
		expect(text(el)).toMatch(/1 failed/);

		// Three rows, each with the truncated 8-char entry id.
		const mono = el.querySelectorAll(".font-mono");
		expect(mono.length).toBe(3);
		expect(mono[0].textContent).toBe("8af3b1c2");

		// Each entry's title appears.
		expect(text(el)).toContain("Daily standup digest");
		expect(text(el)).toContain("Investigate flaky test");
		expect(text(el)).toContain("Process webhook from GitHub");
	});

	it("error result shows failure text", () => {
		const el = renderInbox("list", {}, jsonResult("Inbox not initialised", true), false);
		expect(text(el)).toMatch(/Inbox list failed/i);
		// Pin the message div explicitly (it carries `mt-1`, not the header icon).
		const msg = el.querySelector("div.text-destructive");
		expect(msg?.textContent).toContain("Inbox not initialised");
	});
});

describe("InboxCompleteRenderer", () => {
	it("streaming shows entry id being completed", () => {
		const el = renderInbox("complete", { entry_id: "8af3b1c2-rest" }, undefined, true);
		expect(text(el)).toMatch(/Completing/);
		expect(el.querySelector(".font-mono")?.textContent).toBe("8af3b1c2");
	});

	it("success renders title, completed badge and summary text", () => {
		const data = { id: "8af3b1c2-x", title: "Daily standup digest", state: "completed", result: "Posted to #standup. 7 PRs." };
		const el = renderInbox(
			"complete",
			{ entry_id: "8af3b1c2-x", summary: "Posted to #standup. 7 PRs." },
			jsonResult(data),
			false,
		);
		const t = text(el);
		expect(t).toContain("Completed");
		expect(t).toContain("Daily standup digest");
		expect(t).toContain("completed");
		expect(t).toContain("Posted to #standup. 7 PRs.");
	});

	it("error result shows destructive text", () => {
		const el = renderInbox("complete", { entry_id: "3df9aa01-x" }, jsonResult("409 Conflict: entry not in pending state", true), false);
		expect(text(el)).toMatch(/Failed to complete/);
		expect(el.querySelector("div.text-destructive")?.textContent).toContain("409 Conflict");
	});
});

describe("InboxDismissRenderer", () => {
	it("streaming shows outcome in header", () => {
		const el = renderInbox("dismiss", { entry_id: "19c8b773-x", outcome: "failed", reason: "boom" }, undefined, true);
		const t = text(el);
		expect(t).toMatch(/Dismissing/);
		expect(t).toContain("failed");
	});

	it("success with outcome=failed renders failed badge and reason", () => {
		const data = { id: "19c8b773-x", title: "Process webhook", state: "failed", error: "503 from GitHub API." };
		const el = renderInbox(
			"dismiss",
			{ entry_id: "19c8b773-x", outcome: "failed", reason: "503 from GitHub API." },
			jsonResult(data),
			false,
		);
		const t = text(el);
		expect(t).toContain("Dismissed");
		expect(t).toContain("Process webhook");
		expect(t).toContain("failed");
		expect(t).toContain("503 from GitHub API.");
	});

	it("success with outcome=cancelled renders cancelled (line-through) badge", () => {
		const data = { id: "ec4abc11-x", title: "Duplicate cron", state: "cancelled", error: "Duplicate of 7c5fe991." };
		const el = renderInbox(
			"dismiss",
			{ entry_id: "ec4abc11-x", outcome: "cancelled", reason: "Duplicate of 7c5fe991." },
			jsonResult(data),
			false,
		);
		expect(text(el)).toContain("cancelled");
		// The cancelled badge uses line-through styling.
		expect(el.querySelectorAll(".line-through").length).toBe(1);
	});

	it("error result shows destructive text", () => {
		const el = renderInbox("dismiss", { entry_id: "19c8b773-x", outcome: "failed", reason: "boom" }, jsonResult("409 Conflict", true), false);
		expect(text(el)).toMatch(/Failed to dismiss/);
	});
});

// Migrated from tests/git-status-widget-states.spec.ts (v2-dom tier).
// Mounts the REAL <git-status-widget> Lit component under happy-dom (replacing
// the esbuild file:// bundle), covering the bypass-merge action and the pill's
// render states (skeleton / refreshing / partial / ready / +- segments) plus the
// commit-scoped diff modal flow driven by a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStatusWidget } from "../../src/ui/components/GitStatusWidget.js";

// Under vitest forks (isolate:false) the module — and its @customElement define
// side-effect — runs once, but happy-dom recreates `customElements` per file.
// Re-register so createElement upgrades the widget regardless of load order.
if (!customElements.get("git-status-widget")) customElements.define("git-status-widget", GitStatusWidget);

const dd = () => document.getElementById("git-status-dropdown");
const pill = (el: HTMLElement) => el.querySelector("button")!;
const btnByText = (root: ParentNode, text: string) =>
	Array.from(root.querySelectorAll("button")).find((b) => b.textContent!.trim() === text);
const spanByText = (root: ParentNode, text: string) =>
	Array.from(root.querySelectorAll("span")).find((s) => s.textContent!.trim() === text);

async function mount(props: Record<string, unknown>) {
	document.body.innerHTML = "";
	dd()?.remove();
	document.getElementById("git-commits-modal")?.remove();
	document.getElementById("git-diff-modal")?.remove();
	const el = document.createElement("git-status-widget") as any;
	Object.assign(el, props);
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement & { updateComplete: Promise<unknown> };
}

async function openDropdown(el: any) {
	pill(el).click();
	await el.updateComplete;
	return dd()!;
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(predicate: () => boolean, timeout = 5000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (predicate()) return;
		await delay(10);
	}
	throw new Error("waitFor timed out");
}

const OPEN_PR_PROPS = {
	loading: false,
	branch: "feature/pr",
	primaryBranch: "master",
	isOnPrimary: false,
	clean: true,
	statusFiles: [] as unknown[],
	prState: "OPEN",
	prNumber: 905,
	prTitle: "Needs review",
	prUrl: "https://github.com/example/repo/pull/905",
	prMergeable: "MERGEABLE",
	reviewDecision: "REVIEW_REQUIRED",
};

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	dd()?.remove();
	document.getElementById("git-commits-modal")?.remove();
	document.getElementById("git-diff-modal")?.remove();
});

describe("GitStatusWidget bypass merge action", () => {
	it("renders Bypass merge when viewerCanMergeAsAdmin is true", async () => {
		const el = await mount({ ...OPEN_PR_PROPS, viewerCanMergeAsAdmin: true });
		await openDropdown(el);
		expect(btnByText(dd()!, "Bypass merge")).toBeTruthy();
		expect(dd()!.textContent).not.toContain("Force Merge");
	});

	it("Bypass merge emits pr-merge with admin true", async () => {
		const el = await mount({ ...OPEN_PR_PROPS, viewerCanMergeAsAdmin: true });
		const events: any[] = [];
		el.addEventListener("pr-merge", (e) => events.push((e as CustomEvent).detail));
		await openDropdown(el);
		btnByText(dd()!, "Bypass merge")!.click();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ method: "squash", admin: true });
	});

	it("hides Bypass merge when capability is false even for admins", async () => {
		const el = await mount({ ...OPEN_PR_PROPS, viewerIsAdmin: true, viewerCanMergeAsAdmin: false });
		await openDropdown(el);
		expect(btnByText(dd()!, "Bypass merge")).toBeUndefined();
		expect(dd()!.textContent).not.toContain("Force Merge");
	});

	it("conflicting PR hides Bypass merge even with bypass capability", async () => {
		const el = await mount({ ...OPEN_PR_PROPS, prMergeable: "CONFLICTING", viewerCanMergeAsAdmin: true });
		await openDropdown(el);
		expect(btnByText(dd()!, "Bypass merge")).toBeUndefined();
		expect(dd()!.textContent).toContain("Has conflicts");
	});

	it("non-mergeable PR shows status text when bypass is unavailable", async () => {
		const el = await mount({ ...OPEN_PR_PROPS, prMergeable: "UNKNOWN", viewerCanMergeAsAdmin: false });
		await openDropdown(el);
		expect(btnByText(dd()!, "Bypass merge")).toBeUndefined();
		expect(dd()!.textContent).toContain("Not mergeable");
	});
});

describe("GitStatusWidget render states", () => {
	it("skeleton renders when loading && !branch", async () => {
		const el = await mount({ loading: true, branch: "" });
		const p = pill(el);
		expect(p.getAttribute("data-state")).toBe("skeleton");
		expect(p.getAttribute("aria-busy")).toBe("true");
		expect(p.disabled).toBe(true);
		expect(p.textContent).toContain("Checking git");
		expect(el.querySelectorAll(".git-skeleton-shimmer").length).toBe(1);
	});

	it("pulsing refresh dot when loading && branch", async () => {
		const el = await mount({ loading: true, branch: "feature/x", primaryBranch: "master", isOnPrimary: false, clean: true });
		const p = pill(el);
		expect(p.getAttribute("data-state")).toBe("refreshing");
		expect(p.textContent).toContain("feature/x");
		expect(p.disabled).toBe(false);

		const dot = el.querySelector(".git-refresh-dot")!;
		expect(el.querySelectorAll(".git-refresh-dot").length).toBe(1);
		// happy-dom cascades the injected class rule and resolves the `animation`
		// shorthand computed value, but does not split it into the `animationName`
		// longhand — assert the pulse keyframes are wired via the shorthand.
		expect(getComputedStyle(dot).animation).toContain("git-status-pulse");
		expect(el.querySelectorAll(".git-partial-dot").length).toBe(0);
	});

	it("warning dot when partial && branch", async () => {
		const el = await mount({ loading: false, partial: true, branch: "feature/y", primaryBranch: "master", isOnPrimary: false, clean: false });
		const p = pill(el);
		expect(p.getAttribute("data-state")).toBe("partial");
		expect(p.textContent).toContain("feature/y");
		expect(el.querySelectorAll(".git-partial-dot").length).toBe(1);
		expect(el.querySelectorAll(".git-refresh-dot").length).toBe(0);
		expect(el.querySelectorAll(".git-skeleton-shimmer").length).toBe(0);
	});

	it("normal render when clean and not loading", async () => {
		const el = await mount({ loading: false, partial: false, branch: "master", primaryBranch: "master", isOnPrimary: true, clean: true });
		const p = pill(el);
		expect(p.getAttribute("data-state")).toBe("ready");
		expect(p.textContent).toContain("master");
		expect(p.textContent).toContain("clean");
		expect(el.querySelectorAll(".git-refresh-dot").length).toBe(0);
		expect(el.querySelectorAll(".git-partial-dot").length).toBe(0);
		expect(el.querySelectorAll(".git-skeleton-shimmer").length).toBe(0);
	});

	it("hidden when !loading && !branch", async () => {
		const el = await mount({ loading: false, branch: "" });
		expect(el.querySelectorAll("button").length).toBe(0);
	});

	it("dropdown open fires git-status-dropdown-open event", async () => {
		const el = await mount({ loading: false, branch: "master", primaryBranch: "master", isOnPrimary: true, clean: true });
		let openEvents = 0;
		let fetchEvents = 0;
		el.addEventListener("git-status-dropdown-open", () => openEvents++);
		el.addEventListener("git-fetch", () => fetchEvents++);
		pill(el).click();
		await el.updateComplete;
		expect(openEvents).toBe(1);
		expect(fetchEvents).toBe(1);
	});

	it("+/- line-count segments render on feature branch", async () => {
		const el = await mount({ loading: false, branch: "feature/x", primaryBranch: "master", isOnPrimary: false, clean: true, aheadOfPrimary: 1, insertionsVsPrimary: 12, deletionsVsPrimary: 4 });
		const p = pill(el);
		expect(p.textContent).toContain("+12");
		expect(p.textContent).toContain("-4");
		const plus = Array.from(p.querySelectorAll("span.text-green-600")).filter((s) => s.textContent!.trim() === "+12");
		const minus = Array.from(p.querySelectorAll("span.text-red-600")).filter((s) => s.textContent!.trim() === "-4");
		expect(plus.length).toBe(1);
		expect(minus.length).toBe(1);
	});

	it("+/- segments hidden when both counts are 0", async () => {
		const el = await mount({ loading: false, branch: "feature/x", primaryBranch: "master", isOnPrimary: false, clean: true, aheadOfPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 });
		const p = pill(el);
		expect(p.textContent).not.toMatch(/\+\d/);
		expect(p.textContent).not.toMatch(/-\d/);
	});

	it("+/- segments suppressed on primary branch even when non-zero", async () => {
		const el = await mount({ loading: false, branch: "master", primaryBranch: "master", isOnPrimary: true, clean: true, insertionsVsPrimary: 12, deletionsVsPrimary: 4 });
		const p = pill(el);
		expect(p.textContent).not.toContain("+12");
		expect(p.textContent).not.toContain("-4");
	});

	it("skeleton is non-interactive (no dropdown-open event)", async () => {
		const el = await mount({ loading: true, branch: "" });
		let openEvents = 0;
		el.addEventListener("git-status-dropdown-open", () => openEvents++);
		pill(el).click();
		await el.updateComplete;
		expect(openEvents).toBe(0);
	});

	it("commits modal expands files and opens commit-scoped diff", async () => {
		const fetchCalls: string[] = [];
		vi.stubGlobal("fetch", async (input: any) => {
			const url = String(input);
			fetchCalls.push(url);
			if (url.includes("/commits")) {
				return new Response(JSON.stringify({
					commits: [{
						sha: "abcdef1234567890", shortSha: "abcdef1", message: "Add commit file diff UI",
						author: "Tester", timestamp: new Date().toISOString(), filesChanged: 4, insertions: 12, deletions: 3,
						files: [
							{ path: "src/modified.ts", status: "M", statusLabel: "modified" },
							{ path: "src/added.ts", status: "A", statusLabel: "added" },
							{ path: "src/deleted.ts", status: "D", statusLabel: "deleted" },
							{ oldPath: "src/old-name.ts", path: "src/new-name.ts", status: "R", statusLabel: "renamed" },
						],
					}],
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.includes("/git-diff")) {
				return new Response(JSON.stringify({ diff: "diff --git a/src/new-name.ts b/src/new-name.ts\n+commit diff marker" }), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response("not found", { status: 404 });
		});

		const el = await mount({
			loading: false, branch: "feature/commit-files", primaryBranch: "master", primaryRef: "origin/master",
			isOnPrimary: false, clean: true, aheadOfPrimary: 1, sessionId: "sess-commit-files",
		});

		await openDropdown(el);
		spanByText(dd()!, "1 ahead")!.click();

		const modal = () => document.getElementById("git-commits-modal")!;
		await waitFor(() => !!document.getElementById("git-commits-modal") && modal().textContent!.includes("abcdef1"));
		expect(modal().textContent).toContain("1 Ahead of origin/master Commit");

		const commitRow = modal().querySelector('[data-testid="commit-row"]')!;
		expect(commitRow.textContent).toContain("abcdef1");
		expect(commitRow.textContent).toContain("Add commit file diff UI");

		const disclosure = commitRow.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
		expect(disclosure).toBeTruthy();
		disclosure.click();
		await waitFor(() => !!modal().querySelector('[data-testid="commit-row"] button[aria-expanded="true"]'));

		const row2 = modal().querySelector('[data-testid="commit-row"]')!;
		expect(row2.textContent).toContain("modified");
		expect(row2.textContent).toContain("added");
		expect(row2.textContent).toContain("deleted");
		expect(row2.textContent).toContain("renamed");
		expect(row2.textContent).toContain("src/old-name.ts → src/new-name.ts");

		const fileRow = Array.from(row2.querySelectorAll("button")).find((b) => b.textContent!.includes("src/old-name.ts → src/new-name.ts"))!;
		fileRow.click();

		await waitFor(() => !!document.getElementById("git-diff-modal")?.querySelector("rich-git-diff-viewer"));
		const diffModal = document.getElementById("git-diff-modal")!;
		expect(diffModal.querySelectorAll("rich-git-diff-viewer").length).toBe(1);
		expect(diffModal.querySelector('[role="dialog"]')!.getAttribute("aria-modal")).toBe("true");
		expect(diffModal.querySelectorAll('[aria-label="Close diff modal"]').length).toBe(1);

		const diffUrl = fetchCalls.find((u) => u.includes("/git-diff"))!;
		expect(diffUrl).toContain("/api/sessions/sess-commit-files/git-diff");
		expect(diffUrl).toContain("file=src%2Fnew-name.ts");
		expect(diffUrl).toContain("commit=abcdef1234567890");
	});
});

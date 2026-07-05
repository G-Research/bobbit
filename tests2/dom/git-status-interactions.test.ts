// Migrated from tests/git-status-interactions.spec.ts (v2-dom tier).
// The legacy Playwright fixture drove a plain-JS *replica* of GitStatusWidget.
// Per the migration guide we instead mount the REAL <git-status-widget> Lit
// component under happy-dom and assert the same user-visible behaviours (pill
// segments, dropdown file list, PR controls, and the git-* action events),
// retargeting the replica's ad-hoc data-attributes to the component's real DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStatusWidget } from "../../src/ui/components/GitStatusWidget.js";

// Under vitest forks (isolate:false) the module — and its @customElement define
// side-effect — runs once, but happy-dom recreates `customElements` per file.
// Re-register the class in this file's registry so createElement upgrades it
// regardless of which file loaded the module first.
if (!customElements.get("git-status-widget")) customElements.define("git-status-widget", GitStatusWidget);

async function mount(props: Record<string, unknown> = {}) {
	const el = document.createElement("git-status-widget") as any;
	Object.assign(el, props);
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement & { updateComplete: Promise<unknown> };
}

async function setProps(el: any, props: Record<string, unknown>) {
	Object.assign(el, props);
	await el.updateComplete;
}

const pill = (el: HTMLElement) => el.querySelector("button");
const dd = () => document.getElementById("git-status-dropdown");
const btnByText = (root: ParentNode, text: string) =>
	Array.from(root.querySelectorAll("button")).find((b) => b.textContent!.trim() === text);
const spanByText = (root: ParentNode, text: string) =>
	Array.from(root.querySelectorAll("span")).find((s) => s.textContent!.trim() === text);

async function openDropdown(el: any) {
	pill(el)!.click();
	await el.updateComplete;
	return dd();
}

/** Complete a close animation happy-dom will never fire on its own. */
async function finishClose(el: any) {
	const node = dd();
	if (node) node.dispatchEvent(new Event("animationend", { bubbles: true }));
	await el.updateComplete;
}

function recordEvents(el: HTMLElement, types: string[]) {
	const events: Array<{ type: string; detail: any }> = [];
	for (const t of types) {
		el.addEventListener(t, (e) => events.push({ type: t, detail: (e as CustomEvent).detail }));
	}
	return events;
}

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	dd()?.remove();
});

describe("GitStatusWidget interactions", () => {
	// ── Pill display ──────────────────────────────────────────────
	it("pill shows branch name", async () => {
		const el = await mount({ branch: "feature/abc", clean: true });
		expect(pill(el)!.textContent).toContain("feature/abc");
	});

	it("pill shows 'clean' badge when working tree is clean on primary", async () => {
		const el = await mount({ branch: "master", clean: true, isOnPrimary: true, statusFiles: [] });
		expect(spanByText(pill(el)!, "clean")).toBeTruthy();
	});

	it("pill hides 'clean' badge when there are dirty files", async () => {
		const el = await mount({ branch: "master", clean: false, isOnPrimary: true, statusFiles: [{ file: "a.ts", status: "M" }] });
		expect(spanByText(pill(el)!, "clean")).toBeUndefined();
	});

	it("pill shows dirty file count segment", async () => {
		const el = await mount({ branch: "master", clean: false, statusFiles: [{ file: "a.ts", status: "M" }, { file: "b.ts", status: "A" }] });
		expect(pill(el)!.textContent).toContain("~2");
	});

	it("pill shows ahead/behind primary badges for feature branch", async () => {
		const el = await mount({ branch: "feature/xyz", clean: true, isOnPrimary: false, aheadOfPrimary: 3, behindPrimary: 1, statusFiles: [] });
		expect(pill(el)!.textContent).toContain("↑3");
		expect(pill(el)!.textContent).toContain("↓1");
	});

	it("pill shows PR icon when prState is set", async () => {
		const el = await mount({ branch: "feature/pr", isOnPrimary: false, prState: "OPEN", prNumber: 42, statusFiles: [] });
		expect(pill(el)!.textContent).toContain("#42");
	});

	it("loading state shows pulsing icon", async () => {
		const el = await mount({ branch: "master", loading: true });
		expect(el.querySelector(".git-refresh-dot")).toBeTruthy();
	});

	it("widget renders nothing when no branch and not loading", async () => {
		const el = await mount({ branch: "", loading: false });
		expect(pill(el)).toBeNull();
	});

	// ── Expand / Collapse ─────────────────────────────────────────
	it("clicking pill opens dropdown", async () => {
		const el = await mount({ branch: "master", clean: true, statusFiles: [] });
		await openDropdown(el);
		expect(dd()).toBeTruthy();
	});

	it("clicking pill fires git-fetch event on open", async () => {
		const el = await mount({ branch: "master", clean: true, statusFiles: [] });
		const events = recordEvents(el, ["git-fetch"]);
		await openDropdown(el);
		expect(events.some((e) => e.type === "git-fetch")).toBe(true);
	});

	it("clicking pill again closes dropdown", async () => {
		const el = await mount({ branch: "master", clean: true, statusFiles: [] });
		await openDropdown(el);
		expect(dd()).toBeTruthy();

		pill(el)!.click();
		await el.updateComplete;
		await finishClose(el);
		expect(dd()).toBeNull();
	});

	// ── Dropdown content ──────────────────────────────────────────
	it("dropdown shows branch name", async () => {
		const el = await mount({ branch: "feature/my-branch", clean: true, statusFiles: [] });
		await openDropdown(el);
		expect(dd()!.textContent).toContain("feature/my-branch");
	});

	it("dropdown shows file list with correct status labels", async () => {
		const el = await mount({
			branch: "master", clean: false,
			statusFiles: [
				{ file: "src/a.ts", status: "M" },
				{ file: "src/b.ts", status: "A" },
				{ file: "src/c.ts", status: "D" },
				{ file: "src/d.ts", status: "?" },
				{ file: "src/e.ts", status: "R" },
			],
		});
		await openDropdown(el);
		const statuses = Array.from(dd()!.querySelectorAll("span.font-mono")).map((s) => s.textContent!.trim());
		const names = Array.from(dd()!.querySelectorAll("span.text-foreground.truncate")).map((s) => s.textContent!.trim());
		expect(statuses).toEqual(["modified", "added", "deleted", "untracked", "renamed"]);
		expect(names).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
	});

	it("dropdown shows file count", async () => {
		const el = await mount({ branch: "master", clean: false, statusFiles: [{ file: "a.ts", status: "M" }, { file: "b.ts", status: "M" }, { file: "c.ts", status: "A" }] });
		await openDropdown(el);
		expect(dd()!.textContent).toContain("3 uncommitted changes");
	});

	it("dropdown shows 'Working tree clean' when no files", async () => {
		const el = await mount({ branch: "master", clean: true, statusFiles: [] });
		await openDropdown(el);
		expect(dd()!.textContent).toContain("Working tree clean");
	});

	// ── PR section ────────────────────────────────────────────────
	it("no PR section when prState is undefined", async () => {
		const el = await mount({ branch: "master", clean: true, statusFiles: [] });
		await openDropdown(el);
		expect(dd()!.textContent).not.toContain("Pull Request");
	});

	it("open PR shows link, badge, and merge controls", async () => {
		const el = await mount({
			branch: "feature/pr", isOnPrimary: false, prState: "OPEN", prNumber: 99,
			prTitle: "Add feature", prUrl: "https://github.com/repo/pull/99", prMergeable: "MERGEABLE", statusFiles: [],
		});
		await openDropdown(el);

		const link = dd()!.querySelector("a[href]") as HTMLAnchorElement;
		expect(link.textContent).toContain("#99 Add feature");
		expect(link.getAttribute("href")).toBe("https://github.com/repo/pull/99");

		expect(spanByText(dd()!, "OPEN")).toBeTruthy();

		const mergeBtn = btnByText(dd()!, "Merge PR")!;
		expect(mergeBtn).toBeTruthy();
		expect((mergeBtn as HTMLButtonElement).disabled).toBe(false);

		expect(dd()!.querySelector("select")).toBeTruthy();
	});

	it("merged PR shows badge without merge controls", async () => {
		const el = await mount({
			branch: "feature/done", isOnPrimary: false, prState: "MERGED", prNumber: 50,
			prTitle: "Done feature", prUrl: "https://github.com/repo/pull/50", statusFiles: [],
		});
		await openDropdown(el);
		expect(spanByText(dd()!, "MERGED")).toBeTruthy();
		expect(btnByText(dd()!, "Merge PR")).toBeUndefined();
	});

	it("merge button disabled when PR not mergeable", async () => {
		const el = await mount({
			branch: "feature/conflicts", isOnPrimary: false, prState: "OPEN", prNumber: 77,
			prTitle: "Conflicts", prMergeable: "CONFLICTING", statusFiles: [],
		});
		await openDropdown(el);
		expect((btnByText(dd()!, "Merge PR") as HTMLButtonElement).disabled).toBe(true);
	});

	// ── Event dispatching ─────────────────────────────────────────
	it("pr-merge event fires with merge method", async () => {
		const el = await mount({
			branch: "feature/pr", isOnPrimary: false, prState: "OPEN", prNumber: 10,
			prTitle: "Test", prMergeable: "MERGEABLE", statusFiles: [],
		});
		await openDropdown(el);
		const events = recordEvents(el, ["pr-merge"]);
		btnByText(dd()!, "Merge PR")!.click();
		const merge = events.find((e) => e.type === "pr-merge");
		expect(merge).toBeTruthy();
		expect(merge!.detail.method).toBe("squash");
	});

	it("ask-agent-commit event fires", async () => {
		const el = await mount({ branch: "master", clean: false, statusFiles: [{ file: "a.ts", status: "M" }] });
		await openDropdown(el);
		const events = recordEvents(el, ["ask-agent-commit"]);
		btnByText(dd()!, "Ask agent to commit")!.click();
		expect(events.some((e) => e.type === "ask-agent-commit")).toBe(true);
	});

	it("ask-agent-pr event fires for feature branch ahead of primary", async () => {
		const el = await mount({ branch: "feature/new", isOnPrimary: false, clean: true, aheadOfPrimary: 2, behindPrimary: 0, statusFiles: [] });
		await openDropdown(el);
		const events = recordEvents(el, ["ask-agent-pr"]);
		btnByText(dd()!, "Ask agent to raise PR")!.click();
		expect(events.some((e) => e.type === "ask-agent-pr")).toBe(true);
	});

	it("git-pull event fires for behind remote on primary", async () => {
		const el = await mount({ branch: "master", isOnPrimary: true, clean: true, behind: 3, statusFiles: [] });
		await openDropdown(el);
		const events = recordEvents(el, ["git-pull"]);
		btnByText(dd()!, "Pull")!.click();
		expect(events.some((e) => e.type === "git-pull")).toBe(true);
	});

	it("git-push event fires for ahead remote on primary", async () => {
		const el = await mount({ branch: "master", isOnPrimary: true, clean: true, ahead: 2, statusFiles: [] });
		await openDropdown(el);
		const events = recordEvents(el, ["git-push"]);
		btnByText(dd()!, "Push")!.click();
		expect(events.some((e) => e.type === "git-push")).toBe(true);
	});

	it("git-merge-primary event fires for behind primary on feature branch", async () => {
		const el = await mount({ branch: "feature/behind", isOnPrimary: false, clean: true, behindPrimary: 5, statusFiles: [] });
		await openDropdown(el);
		const events = recordEvents(el, ["git-merge-primary"]);
		btnByText(dd()!, "Rebase on master")!.click();
		expect(events.some((e) => e.type === "git-merge-primary")).toBe(true);
	});

	// ── Primary status messages ───────────────────────────────────
	it("on primary: shows 'Up to date' message", async () => {
		const el = await mount({ branch: "master", isOnPrimary: true, clean: true, statusFiles: [] });
		await openDropdown(el);
		expect(dd()!.textContent).toContain("Up to date with origin/master");
	});

	it("feature branch ahead and behind shows both counts", async () => {
		const el = await mount({ branch: "feature/mixed", isOnPrimary: false, aheadOfPrimary: 4, behindPrimary: 2, clean: true, statusFiles: [] });
		await openDropdown(el);
		const text = dd()!.textContent!;
		expect(text).toContain("4 ahead");
		expect(text).toContain("2 behind");
		expect(text).toContain("origin/master");
	});

	it("merged into primary shows merged message", async () => {
		const el = await mount({ branch: "feature/merged", isOnPrimary: false, mergedIntoPrimary: true, behindPrimary: 0, clean: true, statusFiles: [] });
		await openDropdown(el);
		expect(dd()!.textContent).toContain("Merged into origin/master");
	});

	// ── Dynamic updates while open ─────────────────────────────────
	it("dropdown re-renders when files change while open", async () => {
		const el = await mount({ branch: "master", clean: false, statusFiles: [{ file: "a.ts", status: "M" }] });
		await openDropdown(el);
		expect(dd()!.querySelectorAll("span.font-mono").length).toBe(1);

		await setProps(el, { statusFiles: [{ file: "a.ts", status: "M" }, { file: "b.ts", status: "A" }, { file: "c.ts", status: "D" }] });
		expect(dd()!.querySelectorAll("span.font-mono").length).toBe(3);
	});

	// ── Singular/plural file count ─────────────────────────────────
	it("file count uses singular for 1 file", async () => {
		const el = await mount({ branch: "master", clean: false, statusFiles: [{ file: "a.ts", status: "M" }] });
		await openDropdown(el);
		const text = dd()!.textContent!;
		expect(text).toContain("1 uncommitted change");
		expect(text).not.toContain("uncommitted changes");
	});

	// ── Clean badge suppression ────────────────────────────────────
	it("clean badge hidden on feature branch ahead of primary", async () => {
		const el = await mount({ branch: "feature/ahead", clean: true, isOnPrimary: false, aheadOfPrimary: 1, statusFiles: [] });
		expect(spanByText(pill(el)!, "clean")).toBeUndefined();
	});

	it("clean badge hidden when PR exists", async () => {
		const el = await mount({ branch: "master", clean: true, isOnPrimary: true, prState: "OPEN", prNumber: 1, statusFiles: [] });
		expect(spanByText(pill(el)!, "clean")).toBeUndefined();
	});
});

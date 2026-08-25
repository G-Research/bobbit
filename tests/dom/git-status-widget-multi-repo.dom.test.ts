import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_helpers/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/git-status-widget-multi-repo.spec.ts (v2-dom tier).
// Mounts the REAL <git-status-widget> Lit component under happy-dom (replacing
// the esbuild file:// bundle) with the multi-repo `repos` envelope, asserting
// the per-repo collapsible sections + aggregate pill/header text prescribed by
// docs/design/multi-repo-components.md §8.4.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStatusWidget } from "../../src/ui/components/GitStatusWidget.js";

// Under vitest forks (isolate:false) the module — and its @customElement define
// side-effect — runs once, but happy-dom recreates `customElements` per file.
// Re-register so createElement upgrades the widget regardless of load order.
if (!customElements.get("git-status-widget")) customElements.define("git-status-widget", GitStatusWidget);

const dd = () => document.getElementById("git-status-dropdown");
const pill = (el: HTMLElement) => el.querySelector("button")!;
const rootAction = (root: ParentNode, action: string) =>
	root.querySelector(`[data-testid="git-root-action"][data-git-action="${action}"]`) as HTMLButtonElement | null;

function recordEvents(el: HTMLElement, types: string[]) {
	const events: string[] = [];
	for (const type of types) el.addEventListener(type, () => events.push(type));
	return events;
}

const baseProps = {
	loading: false,
	branch: "goal/multi-repo-foo",
	primaryBranch: "master",
	isOnPrimary: false,
	clean: false,
	statusFiles: [] as Array<{ file: string; status: string }>,
};

async function mount(props: Record<string, unknown>) {
	document.body.innerHTML = "";
	dd()?.remove();
	const el = document.createElement("git-status-widget") as any;
	Object.assign(el, { ...baseProps, ...props });
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement & { updateComplete: Promise<unknown> };
}

async function openDropdown(el: any) {
	pill(el).click();
	await el.updateComplete;
	return dd()!;
}

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; dd()?.remove(); });

describe("GitStatusWidget — multi-repo collapsibles", () => {
	it("multi-repo pill shows aggregate '<N> changed across <M> repos' label", async () => {
		const el = await mount({
			repos: {
				api: { statusFiles: [{ file: "src/a.ts", status: "M" }, { file: "src/b.ts", status: "M" }, { file: "src/c.ts", status: "A" }] },
				web: { statusFiles: [{ file: "index.html", status: "M" }] },
				shared: { statusFiles: [], clean: true },
			},
		});
		const agg = el.querySelector('[data-testid="pill-multi-repo-aggregate"]')!;
		expect(agg).toBeTruthy();
		expect(agg.textContent).toMatch(/4 changed across 2 repos/);
	});

	it("multi-repo pill shows summed ahead/behind/+/- segments across repos", async () => {
		const el = await mount({
			repos: {
				api: { statusFiles: [{ file: "src/a.ts", status: "M" }, { file: "src/b.ts", status: "M" }], aheadOfPrimary: 2, behindPrimary: 1, insertionsVsPrimary: 10, deletionsVsPrimary: 3 },
				web: { statusFiles: [{ file: "index.html", status: "M" }], aheadOfPrimary: 1, behindPrimary: 0, insertionsVsPrimary: 5, deletionsVsPrimary: 2 },
			},
		});
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')!.textContent).toMatch(/3 changed across 2 repos/);
		const text = pill(el).textContent!;
		expect(text).toContain("↓1");
		expect(text).toContain("↑3");
		expect(text).toContain("+15");
		expect(text).toContain("-5");
		expect(text).not.toMatch(/\bclean\b/);
	});

	it("clean multi-repo with non-zero summed ahead/behind still shows segments, not 'clean'", async () => {
		const el = await mount({
			clean: true, statusFiles: [],
			repos: {
				api: { statusFiles: [], clean: true, aheadOfPrimary: 2, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
				web: { statusFiles: [], clean: true, aheadOfPrimary: 1, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
			},
		});
		const text = pill(el).textContent!;
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')).toBeNull();
		expect(text).toContain("↑3");
		expect(text).not.toMatch(/\bclean\b/);
	});

	it("fully clean multi-repo (no dirty, no stats) collapses to single 'clean' indicator", async () => {
		const el = await mount({
			clean: true, isOnPrimary: true, statusFiles: [],
			repos: {
				api: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
				web: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
			},
		});
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')).toBeNull();
		const text = pill(el).textContent!;
		expect(text).toMatch(/\bclean\b/);
		expect(text).not.toContain("↑");
		expect(text).not.toContain("↓");
	});

	it("clean multi-repo on a feature branch (isOnPrimary false) still collapses to single 'clean'", async () => {
		const el = await mount({
			branch: "session/abcd1234", clean: true, isOnPrimary: false, mergedIntoPrimary: false, aheadOfPrimary: 0, statusFiles: [],
			repos: {
				api: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
				web: { statusFiles: [], clean: true, aheadOfPrimary: 0, behindPrimary: 0, insertionsVsPrimary: 0, deletionsVsPrimary: 0 },
			},
		});
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')).toBeNull();
		const text = pill(el).textContent!;
		expect(text).toMatch(/\bclean\b/);
		expect(text).not.toContain("↑");
		expect(text).not.toContain("↓");
	});

	it("sole root entry stays flat for single-repo compatibility", async () => {
		const el = await mount({ clean: true, statusFiles: [], repos: { ".": { statusFiles: [], clean: true } } });
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')).toBeNull();
		await openDropdown(el);
		expect(dd()!.querySelector('[data-testid="multi-repo-sections"]')).toBeNull();
	});

	it("sole named component renders as multi-repo with its repository section", async () => {
		const el = await mount({
			repos: {
				api: { status: [{ file: "src/only.ts", status: "M" }], clean: false },
			},
		});

		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')!.textContent).toMatch(/1 changed across 1 repo/);
		await openDropdown(el);

		const sections = dd()!.querySelectorAll('[data-testid="multi-repo-entry"]');
		expect(sections).toHaveLength(1);
		expect(sections[0].getAttribute("data-repo-name")).toBe("api");
		expect(sections[0].querySelector('[data-testid="repo-name"]')!.textContent!.trim()).toBe("api");
		expect(sections[0].textContent).toContain("src/only.ts");
		expect(dd()!.querySelector('[data-testid="multi-repo-badge"]')!.textContent!.trim()).toBe("1 repo");
	});

	it("named component aggregates keep status readable but expose no root Git actions or history triggers", async () => {
		const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);
		const el = await mount({
			branch: "goal/component-actions",
			isOnPrimary: false,
			aheadOfPrimary: 3,
			behindPrimary: 2,
			viewerIsAdmin: true,
			repos: {
				api: { statusFiles: [], clean: true, aheadOfPrimary: 3, behindPrimary: 2 },
				web: { statusFiles: [], clean: true },
			},
		});
		const events = recordEvents(el, ["git-pull", "git-push", "git-merge-primary", "git-squash-push"]);
		await openDropdown(el);

		expect(dd()!.textContent).toContain("3 ahead");
		expect(dd()!.textContent).toContain("2 behind");
		expect(dd()!.querySelectorAll('[data-testid="git-aggregate-status-count"]')).toHaveLength(2);
		expect(dd()!.querySelector('[data-testid="git-commit-history-trigger"]')).toBeNull();
		expect(dd()!.querySelector('[data-testid="git-root-action"]')).toBeNull();

		// Exercise the direct-push and remote pull/push render branches while the
		// portal is open. Every aggregate count remains a read-only span.
		Object.assign(el, { aheadOfPrimary: 3, behindPrimary: 0 });
		await (el as any).updateComplete;
		expect(rootAction(dd()!, "squash-push")).toBeNull();
		expect(dd()!.querySelector('[data-testid="git-commit-history-trigger"]')).toBeNull();

		Object.assign(el, { isOnPrimary: true, ahead: 2, behind: 1 });
		await (el as any).updateComplete;
		expect(rootAction(dd()!, "pull")).toBeNull();
		expect(dd()!.querySelectorAll('[data-testid="git-aggregate-status-count"]')).toHaveLength(2);

		Object.assign(el, { ahead: 2, behind: 0 });
		await (el as any).updateComplete;
		expect(rootAction(dd()!, "push")).toBeNull();
		Object.assign(el, { ahead: 0, behind: 2 });
		await (el as any).updateComplete;
		expect(rootAction(dd()!, "pull")).toBeNull();

		for (const count of dd()!.querySelectorAll('[data-testid="git-aggregate-status-count"]')) {
			(count as HTMLElement).click();
		}
		expect(events).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(document.getElementById("git-commits-modal")).toBeNull();
	});

	it("named component aggregates retain safe PR display and merge behavior", async () => {
		const el = await mount({
			branch: "goal/component-pr",
			isOnPrimary: false,
			prState: "OPEN",
			prNumber: 42,
			prTitle: "Polyrepo change",
			prUrl: "https://github.com/example/polyrepo/pull/42",
			prMergeable: "MERGEABLE",
			repos: { api: { statusFiles: [], clean: true } },
		});
		const events = recordEvents(el, ["pr-merge"]);
		await openDropdown(el);

		expect(dd()!.querySelector('[data-testid="git-root-action"]')).toBeNull();
		const merge = Array.from(dd()!.querySelectorAll("button"))
			.find((button) => button.textContent!.trim() === "Merge PR") as HTMLButtonElement;
		expect(merge).toBeTruthy();
		merge.click();
		expect(events).toEqual(["pr-merge"]);
	});

	it("a sole root entry retains flat Git action buttons and events", async () => {
		const repos = { ".": { statusFiles: [], clean: true } };

		let el = await mount({
			branch: "feature/ahead",
			isOnPrimary: false,
			aheadOfPrimary: 2,
			behindPrimary: 0,
			viewerIsAdmin: true,
			repos,
		});
		let events = recordEvents(el, ["git-squash-push"]);
		await openDropdown(el);
		expect(rootAction(dd()!, "squash-push")).toBeTruthy();
		expect(dd()!.querySelectorAll('[data-testid="git-commit-history-trigger"]')).toHaveLength(1);
		rootAction(dd()!, "squash-push")!.click();
		expect(events).toEqual(["git-squash-push"]);

		el = await mount({
			branch: "feature/diverged",
			isOnPrimary: false,
			aheadOfPrimary: 2,
			behindPrimary: 1,
			repos,
		});
		events = recordEvents(el, ["git-merge-primary"]);
		await openDropdown(el);
		expect(rootAction(dd()!, "rebase-primary")).toBeTruthy();
		expect(dd()!.querySelectorAll('[data-testid="git-commit-history-trigger"]')).toHaveLength(2);
		rootAction(dd()!, "rebase-primary")!.click();
		expect(events).toEqual(["git-merge-primary"]);

		el = await mount({ branch: "master", isOnPrimary: true, ahead: 2, behind: 0, repos });
		events = recordEvents(el, ["git-push"]);
		await openDropdown(el);
		expect(rootAction(dd()!, "push")).toBeTruthy();
		rootAction(dd()!, "push")!.click();
		expect(events).toEqual(["git-push"]);

		el = await mount({ branch: "master", isOnPrimary: true, ahead: 0, behind: 2, repos });
		events = recordEvents(el, ["git-pull"]);
		await openDropdown(el);
		expect(rootAction(dd()!, "pull")).toBeTruthy();
		rootAction(dd()!, "pull")!.click();
		expect(events).toEqual(["git-pull"]);
	});

	it("dropdown shows one per-repo section per entry, with names and counts", async () => {
		const el = await mount({
			repos: {
				api: { statusFiles: [{ file: "src/a.ts", status: "M" }, { file: "src/b.ts", status: "M" }, { file: "src/c.ts", status: "A" }] },
				web: { statusFiles: [{ file: "index.html", status: "M" }] },
				shared: { statusFiles: [], clean: true },
			},
		});
		await openDropdown(el);

		const sections = dd()!.querySelectorAll('[data-testid="multi-repo-entry"]');
		expect(sections.length).toBe(3);

		const names = Array.from(dd()!.querySelectorAll('[data-testid="repo-name"]')).map((n) => n.textContent!.trim());
		expect(names).toEqual(["api", "web", "shared"]);

		expect(dd()!.querySelector('[data-testid="multi-repo-aggregate"]')!.textContent).toMatch(/4 changed across 2 repos/);

		const apiSection = dd()!.querySelector('[data-repo-name="api"]') as HTMLDetailsElement;
		const sharedSection = dd()!.querySelector('[data-repo-name="shared"]') as HTMLDetailsElement;
		expect(apiSection.hasAttribute("open")).toBe(true);
		expect(sharedSection.open).toBe(false);

		expect(apiSection.querySelector('[data-testid="repo-dirty-count"]')!.textContent!.trim()).toBe("~3");
		expect(sharedSection.querySelector('[data-testid="repo-clean"]')!.textContent!.trim()).toBe("clean");
	});

	it("per-repo section lists the repo's files with correct status labels", async () => {
		const el = await mount({
			repos: {
				api: { statusFiles: [{ file: "src/added.ts", status: "A" }, { file: "src/deleted.ts", status: "D" }, { file: "src/modified.ts", status: "M" }] },
				web: { statusFiles: [{ file: "index.html", status: "M" }] },
			},
		});
		await openDropdown(el);
		const apiSection = dd()!.querySelector('[data-repo-name="api"]')!;
		const text = apiSection.textContent!;
		expect(text).toContain("src/added.ts");
		expect(text).toContain("added");
		expect(text).toContain("src/deleted.ts");
		expect(text).toContain("deleted");
		expect(text).toContain("src/modified.ts");
		expect(text).toContain("modified");
	});

	it("legacy `status` field on per-repo entry also works (back-compat)", async () => {
		const el = await mount({
			repos: {
				api: { status: [{ file: "src/x.ts", status: "M" }] },
				web: { status: [{ file: "y.html", status: "M" }] },
			},
		});
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')!.textContent).toMatch(/2 changed across 2 repos/);
		await openDropdown(el);
		expect(dd()!.querySelectorAll('[data-testid="multi-repo-entry"]').length).toBe(2);
	});

	it("clean multi-repo: aggregate header reads 'N repos clean', no pill aggregate", async () => {
		const el = await mount({
			clean: true,
			repos: { api: { statusFiles: [], clean: true }, web: { statusFiles: [], clean: true } },
		});
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')).toBeNull();
		await openDropdown(el);
		expect(dd()!.querySelector('[data-testid="multi-repo-aggregate"]')!.textContent).toMatch(/2 repos clean/);
		expect(dd()!.querySelectorAll('[data-testid="repo-clean"]').length).toBe(2);
	});

	it("multi-repo dropdown does NOT render the duplicate flat 'uncommitted changes' list", async () => {
		const el = await mount({
			statusFiles: [{ file: "src/a.ts", status: "M" }, { file: "src/b.ts", status: "M" }],
			repos: {
				api: { statusFiles: [{ file: "src/a.ts", status: "M" }, { file: "src/b.ts", status: "M" }] },
				web: { statusFiles: [] },
			},
		});
		await openDropdown(el);
		expect(dd()!.querySelector('[data-testid="multi-repo-sections"]')).toBeTruthy();
		expect(dd()!.textContent).not.toMatch(/uncommitted change/i);
	});
});

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

	it("single-repo (one entry) does NOT trigger multi-repo rendering", async () => {
		const el = await mount({ clean: true, statusFiles: [], repos: { ".": { statusFiles: [], clean: true } } });
		expect(el.querySelector('[data-testid="pill-multi-repo-aggregate"]')).toBeNull();
		await openDropdown(el);
		expect(dd()!.querySelector('[data-testid="multi-repo-sections"]')).toBeNull();
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

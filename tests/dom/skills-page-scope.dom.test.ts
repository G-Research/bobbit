// Reproducing test (TDD red) for the "Fix skill autocomplete gap" goal (9e081770),
// Facet 1 — the Skills page's default skill-list fetch must resolve against the
// currently-active session's project, NOT Headquarters/system.
//
// Today `slashSkillsDetailsUrl()` (src/app/skills-page.ts) fetches
//   /api/slash-skills/details?projectId=${getConfigApiProjectId()}
// and `getConfigApiProjectId()` returns HEADQUARTERS whenever the module-default
// config scope is "system" (src/app/config-scope.ts). The Skills page never seeds
// its scope from `state.activeProjectId`, and it resets to "system" on refresh —
// so the page lists skills resolved against Headquarters while a session's composer
// resolves against the session's own project. The two surfaces diverge.
//
// This asserts that driving the Skills-page load entrypoint with an active project
// P issues its default details fetch against projectId=proj-P. It FAILS on HEAD
// (URL carries projectId=headquarters) and PASSES once the page seeds its scope
// from the active project.
//
// Distinctive failure token: SKILL_AUTOCOMPLETE_GAP.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state, GW_SESSION_KEY } from "../../src/app/state.js";
import { getConfigApiProjectId, setConfigScope } from "../../src/app/config-scope.js";
import { addCustomDir, clearSkillsPageState, handleScopeChange, loadSkillsPageData } from "../../src/app/skills-page.js";
import { restoreActiveProjectFromLastSession } from "../../src/app/skills-active-project.js";
import { HEADQUARTERS_PROJECT_ID } from "../../src/app/headquarters.js";

let capturedUrls: string[] = [];
let prevProjects: any;
let prevActiveProjectId: any;

beforeEach(() => {
	capturedUrls = [];
	prevProjects = state.projects;
	prevActiveProjectId = state.activeProjectId;

	// Active session/project P; Headquarters also present in the project list.
	state.projects = [
		{ id: "proj-P", name: "P" } as any,
		{ id: HEADQUARTERS_PROJECT_ID, name: "Headquarters" } as any,
	];
	state.activeProjectId = "proj-P";

	// Reset config scope to its buggy module default.
	setConfigScope("system");
	clearSkillsPageState();

	vi.stubGlobal("fetch", async (input: any): Promise<Response> => {
		const url = typeof input === "string" ? input : (input && input.url) || String(input);
		capturedUrls.push(url);
		if (url.includes("/api/slash-skills")) {
			return new Response(JSON.stringify({ skills: [], directories: [] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	setConfigScope("system");
	clearSkillsPageState();
	state.projects = prevProjects;
	state.activeProjectId = prevActiveProjectId;
});

const detailsUrl = (): string | undefined => capturedUrls.find((u) => u.includes("/api/slash-skills/details"));

describe("Skills page — default scope tracks the active project", () => {
	it("issues its default slash-skills/details fetch against the active project (not Headquarters)", async () => {
		await loadSkillsPageData();

		const url = detailsUrl();
		expect(url, "SKILL_AUTOCOMPLETE_GAP: skills page should fetch a slash-skills/details URL").toBeTruthy();
		expect(url!, "SKILL_AUTOCOMPLETE_GAP: skills page must default to active project").toContain("projectId=proj-P");
	});

	it("resolves getConfigApiProjectId() to the active project after page-open seeding", async () => {
		await loadSkillsPageData();

		expect(
			getConfigApiProjectId(),
			"SKILL_AUTOCOMPLETE_GAP: config api projectId must be the active project, not Headquarters",
		).toBe("proj-P");
	});
});

describe("Skills page — scope follows later active-project changes (no first-load latch)", () => {
	it("reseeds to a newly-active project Q on a subsequent load when the user has not picked a scope", async () => {
		// First load with active=proj-P seeds scope→P.
		state.projects = [
			{ id: "proj-P", name: "P" } as any,
			{ id: "proj-Q", name: "Q" } as any,
			{ id: HEADQUARTERS_PROJECT_ID, name: "Headquarters" } as any,
		];
		state.activeProjectId = "proj-P";
		await loadSkillsPageData();
		expect(getConfigApiProjectId(), "SKILL_AUTOCOMPLETE_GAP: first load seeds active project P").toBe("proj-P");

		// User switches to a proj-Q session WITHOUT clicking the Skills-page scope selector.
		state.activeProjectId = "proj-Q";
		capturedUrls = [];
		await loadSkillsPageData();

		expect(
			getConfigApiProjectId(),
			"SKILL_AUTOCOMPLETE_GAP: scope must follow active project P→Q, not latch on the first load",
		).toBe("proj-Q");
		const url = detailsUrl();
		expect(url, "SKILL_AUTOCOMPLETE_GAP: reseeded load should fetch a details URL").toBeTruthy();
		expect(url!, "SKILL_AUTOCOMPLETE_GAP: reseeded details URL must carry projectId=proj-Q").toContain("projectId=proj-Q");
	});

	it("does NOT override an explicit scope choice when the active project later changes", async () => {
		state.projects = [
			{ id: "proj-P", name: "P" } as any,
			{ id: "proj-Q", name: "Q" } as any,
			{ id: HEADQUARTERS_PROJECT_ID, name: "Headquarters" } as any,
		];
		state.activeProjectId = "proj-P";
		await loadSkillsPageData();
		expect(getConfigApiProjectId()).toBe("proj-P");

		// User explicitly picks the system/Headquarters scope on the Skills page.
		await handleScopeChange("system");
		expect(getConfigApiProjectId(), "explicit choice → Headquarters").toBe(HEADQUARTERS_PROJECT_ID);

		// Active project later changes to Q. The explicit choice must survive.
		state.activeProjectId = "proj-Q";
		capturedUrls = [];
		await loadSkillsPageData();

		expect(
			getConfigApiProjectId(),
			"SKILL_AUTOCOMPLETE_GAP: an explicit scope pick must not be overridden by active-project changes",
		).toBe(HEADQUARTERS_PROJECT_ID);
		const url = detailsUrl();
		expect(url!, "explicit Headquarters scope keeps the details URL on Headquarters").toContain(`projectId=${encodeURIComponent(HEADQUARTERS_PROJECT_ID)}`);
	});
});

// Fix A [HIGH] — saveCustomDirs must NOT corrupt multi-type config_directories.
// The Skills page manages ONLY skills-only dirs; a multi-type {path,types:[skills,mcp]}
// entry must survive a save verbatim (never downgraded to skills-only), and no path
// may be emitted both as multi-type and skills-only (the server resolver dedups by
// expanded path with LATER entries winning, so a skills-only duplicate would strip
// mcp/tools/agents from the shared dir).
describe("Skills page — saveCustomDirs preserves multi-type config_directories", () => {
	let putBodies: any[] = [];

	function stubConfig(): void {
		putBodies = [];
		vi.stubGlobal("fetch", async (input: any, init?: any): Promise<Response> => {
			const url = typeof input === "string" ? input : (input && input.url) || String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.includes("/config")) {
				if (method === "PUT") {
					try { putBodies.push(JSON.parse(init.body)); } catch { putBodies.push(init?.body); }
					return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
				}
				return new Response(JSON.stringify({
					config_directories: [
						{ path: "/shared", types: ["skills", "mcp"] },
						{ path: "/onlyskills", types: ["skills"] },
					],
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.includes("/api/slash-skills")) {
				return new Response(JSON.stringify({ skills: [], directories: [] }), {
					status: 200, headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
		});
	}

	it("keeps a shared multi-type dir intact and never emits a downgrading skills-only duplicate", async () => {
		stubConfig();
		await loadSkillsPageData();
		// Only the skills-only dir is page-managed; the multi-type /shared is excluded.
		await addCustomDir("/newdir");

		expect(putBodies.length, "saveCustomDirs should PUT once").toBeGreaterThan(0);
		const body = putBodies[putBodies.length - 1];
		const dirs: Array<{ path: string; types: string[] }> = body.config_directories;
		expect(Array.isArray(dirs)).toBe(true);
		expect(body.skill_directories).toBeNull();

		const shared = dirs.filter((d) => d.path === "/shared");
		expect(shared.length, "exactly one /shared entry — no duplicate").toBe(1);
		expect(shared[0].types).toContain("skills");
		expect(shared[0].types, "/shared must keep its mcp type (not downgraded)").toContain("mcp");

		expect(dirs.some((d) => d.path === "/onlyskills" && d.types.length === 1 && d.types[0] === "skills")).toBe(true);
		expect(dirs.some((d) => d.path === "/newdir" && d.types.length === 1 && d.types[0] === "skills")).toBe(true);
	});

	it("does not crash when the Add button passes a MouseEvent (ignores non-string arg)", async () => {
		stubConfig();
		await loadSkillsPageData();
		putBodies = [];
		// The Add button binds `@click=${addCustomDir}`, so Lit hands the handler a
		// MouseEvent as its first argument. The optional `path` must be ignored when
		// it is not a string; with the input empty this is a no-op (no throw, no PUT).
		await expect(addCustomDir(new Event("click") as any)).resolves.toBeUndefined();
		expect(putBodies.length, "empty input + Event arg must not save").toBe(0);
	});

	it("guards against a user re-adding a multi-type path as a skills-only custom dir", async () => {
		stubConfig();
		await loadSkillsPageData();
		// User manually re-adds the shared multi-type path; the guard must skip it so
		// it can't create a downgrading skills-only duplicate.
		await addCustomDir("/shared");

		const body = putBodies[putBodies.length - 1];
		const dirs: Array<{ path: string; types: string[] }> = body.config_directories;
		const shared = dirs.filter((d) => d.path === "/shared");
		expect(shared.length, "still exactly one /shared entry").toBe(1);
		expect(shared[0].types).toContain("mcp");
	});
});

// Fix B [HIGH] — on a hard-refresh #/skills deep-link, the active project must be
// derived from the last-connected session (localStorage GW_SESSION_KEY), not the
// first project setProjects() defaults to.
describe("Skills page — restoreActiveProjectFromLastSession", () => {
	it("sets activeProjectId to the last-connected session's project", () => {
		state.gatewaySessions = [{ id: "sess1", projectId: "proj-P" } as any];
		localStorage.setItem(GW_SESSION_KEY, "sess1");
		state.activeProjectId = null;

		restoreActiveProjectFromLastSession();

		expect(state.activeProjectId).toBe("proj-P");
		localStorage.removeItem(GW_SESSION_KEY);
	});

	it("is a no-op when the persisted session is unknown", () => {
		state.gatewaySessions = [{ id: "other", projectId: "proj-Z" } as any];
		localStorage.setItem(GW_SESSION_KEY, "missing");
		state.activeProjectId = "proj-existing";

		restoreActiveProjectFromLastSession();

		expect(state.activeProjectId).toBe("proj-existing");
		localStorage.removeItem(GW_SESSION_KEY);
	});
});

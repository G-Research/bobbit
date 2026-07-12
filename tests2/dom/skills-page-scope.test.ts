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
import { state } from "../../src/app/state.js";
import { getConfigApiProjectId, setConfigScope } from "../../src/app/config-scope.js";
import { clearSkillsPageState, handleScopeChange, loadSkillsPageData } from "../../src/app/skills-page.js";
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

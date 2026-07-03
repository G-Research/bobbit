/**
 * Reproduces sidebar archived search being bounded to the first archived page.
 *
 * Coverage Overhead is seeded older than the initial 50 archived-session page.
 * Searching the sidebar should still surface it via the archived query path.
 */
import { expect } from "@playwright/test";
import { test } from "../gateway-harness.js";
import { apiFetch, registerProject, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SessionStoreLike = {
	put(session: unknown): void;
	remove(id: string): void;
};

function uniqueSuffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionStoreForProject(gateway: unknown, projectId: string): SessionStoreLike {
	const sm = (gateway as { sessionManager?: unknown }).sessionManager as {
		getProjectContextManager?: () => unknown;
		projectContextManager?: unknown;
	};
	const pcm = (sm.getProjectContextManager?.() ?? sm.projectContextManager) as {
		getOrCreate(projectId: string): { sessionStore: SessionStoreLike };
	};
	return pcm.getOrCreate(projectId).sessionStore;
}

function seedArchivedSessionPage(store: SessionStoreLike, projectId: string, rootPath: string, suffix: string): {
	coverageId: string;
	fillerIds: string[];
	oldFillerId: string;
} {
	const now = Date.now();
	const fillerIds: string[] = [];
	for (let i = 0; i < 50; i++) {
		const id = `archived-search-filler-${suffix}-${i}`;
		fillerIds.push(id);
		const archivedAt = now - (i * 1_000);
		store.put({
			id,
			title: `Archived Sidebar Filler ${suffix} ${i}`,
			cwd: rootPath,
			agentSessionFile: join(rootPath, `${id}.jsonl`),
			createdAt: archivedAt - 60_000,
			lastActivity: archivedAt - 30_000,
			projectId,
			role: "tester",
			archived: true,
			archivedAt,
		});
	}

	const coverageId = `archived-search-coverage-${suffix}`;
	store.put({
		id: coverageId,
		title: "Coverage Overhead",
		cwd: rootPath,
		agentSessionFile: join(rootPath, `${coverageId}.jsonl`),
		createdAt: now - 120_000,
		lastActivity: now - 110_000,
		projectId,
		role: "tester",
		archived: true,
		archivedAt: now - 100_000,
	});

	const oldFillerId = `archived-search-old-filler-${suffix}`;
	store.put({
		id: oldFillerId,
		title: `Archived Sidebar Old Filler ${suffix}`,
		cwd: rootPath,
		agentSessionFile: join(rootPath, `${oldFillerId}.jsonl`),
		createdAt: now - 130_000,
		lastActivity: now - 125_000,
		projectId,
		role: "tester",
		archived: true,
		archivedAt: now - 101_000,
	});

	return { coverageId, fillerIds, oldFillerId };
}

test.describe("Sidebar archived search reproducer", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("search surfaces an archived session beyond the initial archived page under its project", async ({ page, gateway }) => {
		test.setTimeout(60_000);
		const suffix = uniqueSuffix();
		const projectName = `archived-sidebar-search-${suffix}`;
		const rootPath = join(tmpdir(), `bobbit-e2e-${projectName}`);
		mkdirSync(rootPath, { recursive: true });
		const project = await registerProject({ name: projectName, rootPath });
		const store = sessionStoreForProject(gateway, project.id);
		const { coverageId, fillerIds, oldFillerId } = seedArchivedSessionPage(store, project.id, rootPath, suffix);
		const seededIds = [...fillerIds, coverageId, oldFillerId];

		try {
			const firstPageResp = await apiFetch(`/api/sessions?include=archived&limit=50&projectId=${encodeURIComponent(project.id)}`);
			expect(firstPageResp.status).toBe(200);
			const firstPage = await firstPageResp.json() as { sessions: Array<{ id: string; archived?: boolean }>; hasMore?: boolean };
			expect(firstPage.hasMore, "sanity: Coverage Overhead must be past the initial archived page").toBe(true);
			expect(firstPage.sessions.some(s => s.id === coverageId)).toBe(false);

			await page.addInitScript(() => {
				localStorage.removeItem("bobbit-sidebar-tree-state:v1");
				localStorage.removeItem("bobbit-expanded-projects");
				localStorage.removeItem("bobbit-archived-collapsed-projects");
				localStorage.setItem("bobbit-show-archived", "false");
			});
			await openApp(page);

			const searchInput = page.locator("input[data-search]").first();
			await expect(searchInput).toBeVisible({ timeout: 10_000 });
			await searchInput.fill("coverage");

			const projectSection = page.locator(`.project-reorder-section[data-project-id="${project.id}"]`).first();
			await expect(projectSection.locator("[data-testid='project-header']").filter({ hasText: projectName })).toBeVisible({ timeout: 10_000 });
			await expect(
				projectSection.locator(`[data-session-id="${coverageId}"]`).first(),
				"ARCHIVED_SIDEBAR_SEARCH_REPRO Coverage Overhead should appear under its project archived section even though it is beyond the first archived page",
			).toBeVisible({ timeout: 15_000 });
			await expect(projectSection.locator(`[data-session-id="${coverageId}"]`).first()).toContainText("Coverage Overhead");
			await expect(page.locator(`[data-session-id="${fillerIds[0]}"]`), "active archived search should hide non-matching archived sessions").toHaveCount(0);
		} finally {
			for (const id of seededIds) store.remove(id);
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			rmSync(rootPath, { recursive: true, force: true });
		}
	});
});

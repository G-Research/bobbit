import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";
import { test, expect } from "../../e2e/gateway-harness.js";
import { apiFetch, createSession, deleteSession, rawApiFetch, registerProject } from "../../e2e/e2e-setup.js";
import { openApp, navigateToHash } from "../../e2e/ui/ui-helpers.js";

const PROJECT_TAB = '[data-testid="side-panel-tab"][data-panel-tab-id="proposal:project"]';
const createdProjects = new Set<string>();
const createdSessions = new Set<string>();
const createdDirs = new Set<string>();
let operatorCookie: string | undefined;

async function authenticatedOperatorCookie(): Promise<string> {
	if (operatorCookie) return operatorCookie;
	const response = await rawApiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const cookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
	operatorCookie = cookies.map((cookie) => cookie.split(";")[0]).find((cookie) => cookie.startsWith("bobbit_session="));
	if (!operatorCookie) throw new Error("operator bootstrap did not mint a bobbit_session cookie");
	return operatorCookie;
}

async function createProject() {
	const rootPath = mkdtempSync(join(tmpdir(), "bobbit-mid-proposal-"));
	createdDirs.add(rootPath);
	const project = await registerProject({
		name: `mid-proposal-${Date.now()}`,
		rootPath,
		components: [{ name: "app", repo: "." }],
	});
	createdProjects.add(project.id);
	return { id: project.id, rootPath, name: String(project.name) };
}

async function openProjectSession(page: Page, project: { id: string; rootPath: string }): Promise<string> {
	const sessionId = await createSession({ cwd: project.rootPath, projectId: project.id });
	createdSessions.add(sessionId);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => page.evaluate((id) => {
		const state = (window as any).bobbitState;
		return state?.selectedSessionId === id
			&& state?.connectingSessionId === null
			&& state?.remoteAgent?.gatewaySessionId === id
			&& typeof state.remoteAgent.onProposal === "function";
	}, sessionId), { timeout: 10_000 }).toBe(true);
	return sessionId;
}

async function seedProposal(page: Page, sessionId: string, project: { id: string; rootPath: string; name: string }) {
	const fields = {
		projectId: project.id,
		name: project.name,
		root_path: project.rootPath,
		build_command: "npm run build",
		test_command: "npm test",
	};
	const response = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
		method: "POST",
		headers: { Cookie: await authenticatedOperatorCookie() },
		body: JSON.stringify({ args: fields }),
	});
	expect(response.status).toBe(200);
	const { rev } = await response.json() as { rev: number };

	const persisted = await (await apiFetch(`/api/sessions/${sessionId}/proposals`)).json() as {
		proposals: Array<{ proposalType: string; fields: Record<string, unknown>; rev: number }>;
	};
	const proposal = persisted.proposals.find((candidate) => candidate.proposalType === "project");
	expect(proposal).toMatchObject({ fields, rev });

	const mode = await page.evaluate(({ sessionId, fields, rev }) => {
		const state = (window as any).bobbitState;
		state.remoteAgent.onProposal("project", fields, false, rev, "rehydrate");
		return state.activeProposals?.project?.sessionId === sessionId
			? state.activeProposals.project.mode
			: null;
	}, { sessionId, fields: proposal!.fields, rev });
	expect(mode).toBe("registered");
}

async function buildCommandValue(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		for (const row of Array.from(document.querySelectorAll('[data-testid="command-row"]'))) {
			const key = row.querySelector<HTMLInputElement>('[data-testid="command-key"]');
			if (key?.value === "build") return row.querySelector<HTMLInputElement>('[data-testid="command-value"]')?.value ?? null;
		}
		return null;
	});
}

test.describe("Mid-session project proposal", () => {
	test.afterEach(async () => {
		for (const id of Array.from(createdSessions).reverse()) await deleteSession(id).catch(() => {});
		createdSessions.clear();
		for (const id of Array.from(createdProjects).reverse()) await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
		createdProjects.clear();
		for (const dir of Array.from(createdDirs).reverse()) rmSync(dir, { recursive: true, force: true });
		createdDirs.clear();
	});

	test("a registered proposal applies without ending the session and invalidates the settings cache", async ({ page }) => {
		const project = await createProject();
		await apiFetch(`/api/projects/${project.id}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "baseline-build" }),
		});
		await openApp(page);

		await navigateToHash(page, `#/settings/${project.id}/components`);
		const initialCard = page.locator('[data-testid="component-card"]').first();
		await expect(initialCard).toBeVisible({ timeout: 15_000 });
		await initialCard.locator(".wf-gate-header").first().click();
		await expect.poll(() => buildCommandValue(page)).toBe("baseline-build");

		const sessionId = await openProjectSession(page, project);
		await seedProposal(page, sessionId, project);
		await expect(page.locator(PROJECT_TAB)).toBeVisible({ timeout: 10_000 });
		const panel = page.locator('[data-panel="project-proposal"][data-mode="registered"]').first();
		await expect(panel).toBeVisible({ timeout: 10_000 });
		await expect(panel.getByTestId("accept-label")).toContainText("Apply Changes");
		await panel.getByRole("button", { name: "Apply Changes", exact: true }).click();

		await expect(page.locator(PROJECT_TAB)).toHaveCount(0, { timeout: 10_000 });
		await expect(page.locator("textarea").first()).toBeVisible();
		expect((await (await apiFetch(`/api/projects/${project.id}/config`)).json()).build_command).toBe("npm run build");

		await navigateToHash(page, `#/settings/${project.id}/components`);
		const refreshedCard = page.locator('[data-testid="component-card"]').first();
		await expect(refreshedCard).toBeVisible({ timeout: 15_000 });
		await refreshedCard.locator(".wf-gate-header").first().click();
		await expect.poll(() => buildCommandValue(page)).toBe("npm run build");
	});
});

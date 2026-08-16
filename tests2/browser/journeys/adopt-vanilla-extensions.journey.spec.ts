/**
 * Journey: adopt stock extensions (EP-9).
 *
 * The stock server and skills folders are exercised by focused runtime tests.
 * This browser journey owns the Market interaction contract, using the same
 * API routing pattern as other browser journeys so it can isolate its durable
 * adoption ledger from the shared gateway worker.
 */
import type { Page, Route } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, apiFetch, defaultProject, openApp, navigateToHash, registerProject } from "../_helpers/journey-fixture.js";

type Adoption = {
	id: string;
	kind: "mcp" | "skills";
	scope: "server" | "global-user" | "project";
	projectId?: string;
	namespace: string;
	enabled: boolean;
	operations?: Array<{ name: string; classification: "read-only-hint" | "unknown" | "mutation-or-contradictory"; selected: boolean }>;
	provenance: {
		class: "adopted";
		sourceType: "stdio" | "claude-skills-directory";
		sourceLocation: string;
		createdAt: string;
		updatedAt: string;
	};
	conformance: {
		state: "loaded" | "partial";
		failures: Array<{ code: string; message: string }>;
		mcp?: { negotiatedProtocol: string; serverName: string; serverVersion: string; loadedTools: string[]; rejectedTools: Array<{ name: string; reason: string }> };
		skills?: { loadedSkills: string[]; rejectedSkills: Array<{ path: string; reason: string }> };
	};
};

const NOW = "2026-01-02T03:04:05.000Z";
const SKILLS_FIXTURE = "/fixtures/adoptions/plain-claude-skills";
const MCP_FIXTURE_ARG = "tests2/fixtures/adoptions/stock-mcp-server.mjs";

function skillsAdoption(projectId: string): Adoption {
	return {
		id: "skills-fixture",
		kind: "skills",
		scope: "project",
		projectId,
		namespace: "adopt-skills-fixture",
		enabled: true,
		provenance: {
			class: "adopted",
			sourceType: "claude-skills-directory",
			sourceLocation: SKILLS_FIXTURE,
			createdAt: NOW,
			updatedAt: NOW,
		},
		conformance: {
			state: "partial",
			failures: [{ code: "malformed_skill", message: "One malformed skill was skipped." }],
			skills: {
				loadedSkills: ["adopt-skills-fixture--stock-summary"],
				rejectedSkills: [{ path: "bad-frontmatter.md", reason: "Malformed frontmatter" }],
			},
		},
	};
}

function mcpAdoption(projectId: string): Adoption {
	return {
		id: "mcp-fixture",
		kind: "mcp",
		scope: "project",
		projectId,
		namespace: "adopt-mcp-fixture",
		enabled: true,
		operations: [
			{ name: "read_docs", classification: "read-only-hint", selected: true },
			{ name: "unknown_status", classification: "unknown", selected: false },
			{ name: "delete_docs", classification: "mutation-or-contradictory", selected: false },
		],
		provenance: {
			class: "adopted",
			sourceType: "stdio",
			sourceLocation: "node",
			createdAt: NOW,
			updatedAt: NOW,
		},
		conformance: {
			state: "loaded",
			failures: [],
			mcp: {
				negotiatedProtocol: "2025-03-26",
				serverName: "Stock fixture MCP",
				serverVersion: "1.2.3",
				loadedTools: ["read_docs"],
				rejectedTools: [
					{ name: "unknown_status", reason: "Unknown capability" },
					{ name: "delete_docs", reason: "Mutation or contradictory hint" },
				],
			},
		},
	};
}

function unrelatedAdoption(): Adoption {
	return {
		id: "unrelated-server-extension",
		kind: "skills",
		scope: "server",
		namespace: "adopt-unrelated-server-extension",
		enabled: true,
		provenance: {
			class: "adopted",
			sourceType: "claude-skills-directory",
			sourceLocation: "/fixtures/adoptions/unrelated-assets",
			createdAt: NOW,
			updatedAt: NOW,
		},
		conformance: {
			state: "loaded",
			failures: [],
			skills: { loadedSkills: ["adopt-unrelated-server-extension--keep-me"], rejectedSkills: [] },
		},
	};
}

async function openMarket(page: Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/market");
	await expect(page.getByTestId("market-adopt-panel")).toBeVisible({ timeout: 20_000 });
}

async function removeAdoption(page: Page, id: string): Promise<void> {
	const card = page.locator(`[data-testid="market-adoption-card"][data-adoption-id="${id}"]`);
	await card.getByTestId("market-adoption-remove").click();
	await expect(page.getByText("The source asset and existing Tools policy settings are untouched.").last()).toBeVisible();
	await page.getByRole("button", { name: "Remove", exact: true }).last().click();
	await expect(card).toHaveCount(0, { timeout: 15_000 });
}

async function mockUnrelatedMarketplaceData(page: Page): Promise<void> {
	// This journey owns only adoption. Keep unrelated source/catalogue work
	// deterministic while preserving installed packs: EP-7 derives each project's
	// settings-required state from their declared runtime contributions.
	await page.route("**/api/marketplace/sources**", (route) => route.fulfill({ json: { sources: [] } }));
	await page.route("**/api/marketplace/browse**", (route) => route.fulfill({ json: { sources: [], packs: [] } }));
	await page.route("**/api/packs/conflicts**", (route) => route.fulfill({ json: { conflicts: [] } }));
}

test.describe("Journey: Adopt Vanilla Extensions", () => {
	test.fixme("adopts scoped skills and MCP with provenance, least privilege, persistence, isolation, and cleanup", { annotation: { type: "fixme", description: "Blocked: Market adoption UI (market-adopt-panel) is absent from src/ despite the documented API contract." } }, async ({ page }) => {
		test.setTimeout(60_000);
		const project = await defaultProject();
		const secondaryRoot = mkdtempSync(join(tmpdir(), "bobbit-adoption-browser-project-"));
		const secondary = await registerProject({
			name: `adoption-isolation-${Date.now()}`,
			rootPath: secondaryRoot,
			seedWorkflows: false,
		});
		const records = new Map<string, Adoption>([["unrelated-server-extension", unrelatedAdoption()]]);
		const posted: unknown[] = [];
		const deleted: string[] = [];

		await mockUnrelatedMarketplaceData(page);
		await page.route("**/api/marketplace/adoptions**", async (route: Route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === "GET") {
				const projectId = url.searchParams.get("projectId");
				const adoptions = [...records.values()].filter((record) =>
					record.scope !== "project" || record.projectId === projectId,
				);
				await route.fulfill({ json: { adoptions } });
				return;
			}
			if (request.method() === "POST" && url.pathname.endsWith("/adoptions")) {
				const body = request.postDataJSON();
				posted.push(body);
				const adoption = body.kind === "skills" ? skillsAdoption(project.id) : mcpAdoption(project.id);
				records.set(adoption.id, adoption);
				await route.fulfill({ status: 201, json: { adoption } });
				return;
			}
			if (request.method() === "DELETE") {
				const id = decodeURIComponent(url.pathname.split("/").pop() || "");
				deleted.push(`${id}:${url.searchParams.get("scope")}:${url.searchParams.get("projectId")}`);
				records.delete(id);
				await route.fulfill({ status: 200, json: {} });
				return;
			}
			await route.fallback();
		});

		try {
			await openMarket(page);
			const scope = page.getByTestId("market-adopt-scope");
			// Project adoption must refresh the current project's Market data even
			// when its canonical installed route is already selected.
			await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/market/${project.id}/installed`);
			await scope.selectOption(`project:${project.id}`);
			await expect(page.getByTestId("market-adopt-least-privilege")).toContainText("only operations positively declared read-only");

			await page.getByTestId("market-adopt-kind-skills").click();
			await page.getByTestId("market-adopt-skills-directory").fill(SKILLS_FIXTURE);
			await page.getByTestId("market-adopt-inspect").click();
			const skillsCard = page.locator('[data-testid="market-adoption-card"][data-adoption-id="skills-fixture"]');
			await expect(skillsCard).toBeVisible({ timeout: 15_000 });
			await expect(skillsCard).toContainText("Adopted");
			await expect(skillsCard.getByTestId("market-adoption-provenance")).toContainText("claude-skills-directory");
			await expect(skillsCard).toContainText("adopt-skills-fixture");
			await expect(skillsCard).toContainText("adopt-skills-fixture--stock-summary");
			await expect(skillsCard).toContainText("1 rejected");

			// Repeat on the unchanged route for MCP as well; each successful POST
			// must refresh its own project-scoped adoption ledger immediately.
			await page.getByTestId("market-adopt-kind-command").click();
			await page.getByTestId("market-adopt-command").fill("node");
			await page.getByTestId("market-adopt-args").fill(MCP_FIXTURE_ARG);
			await page.getByTestId("market-adopt-inspect").click();
			const mcpCard = page.locator('[data-testid="market-adoption-card"][data-adoption-id="mcp-fixture"]');
			await expect(mcpCard).toBeVisible({ timeout: 15_000 });
			await expect(mcpCard.getByTestId("market-adoption-provenance")).toContainText("adopt-mcp-fixture");
			await expect(mcpCard).toContainText("Stock fixture MCP v1.2.3 · protocol 2025-03-26");
			await expect(mcpCard).toContainText("read_docs");
			await expect(mcpCard.getByTestId("market-adoption-operation-read_docs")).toContainText("Policy in Tools");
			await expect(mcpCard.getByTestId("market-adoption-operation-unknown_status")).toContainText("Not exposed");
			await expect(mcpCard.getByTestId("market-adoption-operation-delete_docs")).toContainText("Not exposed");
			await expect(mcpCard).not.toContainText(MCP_FIXTURE_ARG);

			expect(posted).toEqual([
			{ kind: "skills", scope: "project", projectId: project.id, source: { directory: SKILLS_FIXTURE } },
			{ kind: "mcp", scope: "project", projectId: project.id, source: { transport: "stdio", command: "node", args: [MCP_FIXTURE_ARG] } },
		]);

			await page.reload();
			await expect(page.getByTestId("market-adopt-panel")).toBeVisible({ timeout: 20_000 });
			await scope.selectOption(`project:${project.id}`);
			await expect(skillsCard).toBeVisible({ timeout: 15_000 });
			await expect(mcpCard).toBeVisible();

			await page.locator(`[data-testid="market-project-scope"][data-project-id="${secondary.id}"]`).click();
			await expect(skillsCard).toHaveCount(0, { timeout: 15_000 });
			await expect(mcpCard).toHaveCount(0);
			await expect(page.locator('[data-adoption-id="unrelated-server-extension"]')).toBeVisible();

			await page.locator(`[data-testid="market-project-scope"][data-project-id="${project.id}"]`).click();
			await expect(skillsCard).toBeVisible({ timeout: 15_000 });
			await removeAdoption(page, "skills-fixture");
			await removeAdoption(page, "mcp-fixture");
			await page.reload();
			await expect(page.getByTestId("market-adopt-panel")).toBeVisible({ timeout: 20_000 });
			await scope.selectOption(`project:${project.id}`);
			await expect(page.locator('[data-adoption-id="skills-fixture"]')).toHaveCount(0);
			await expect(page.locator('[data-adoption-id="mcp-fixture"]')).toHaveCount(0);
			await expect(page.locator('[data-adoption-id="unrelated-server-extension"]')).toBeVisible();
			expect(deleted).toEqual([
			`skills-fixture:project:${project.id}`,
			`mcp-fixture:project:${project.id}`,
		]);
		} finally {
			await apiFetch(`/api/projects/${secondary.id}`, { method: "DELETE" }).catch(() => {});
			rmSync(secondaryRoot, { recursive: true, force: true });
		}
	});
});

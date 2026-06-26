import { expect, test, type Page } from "../gateway-harness.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const tid = (id: string) => `[data-testid="${id}"]`;

type AgentDirState = Record<string, any>;

function pickPath(state: AgentDirState, ...keys: string[]): string {
	for (const key of keys) {
		const value = key.split(".").reduce<any>((current, part) => current?.[part], state);
		if (typeof value === "string" && value.length > 0) return value;
	}
	throw new Error(`Agent directory state missing path for ${keys.join(" | ")}: ${JSON.stringify(state)}`);
}

function pickText(state: AgentDirState, ...keys: string[]): string {
	for (const key of keys) {
		const value = key.split(".").reduce<any>((current, part) => current?.[part], state);
		if (typeof value === "string" && value.length > 0) return value;
	}
	throw new Error(`Agent directory state missing text for ${keys.join(" | ")}: ${JSON.stringify(state)}`);
}

async function readAgentDirState(): Promise<AgentDirState> {
	const resp = await apiFetch("/api/agent-dir");
	expect(resp.ok).toBe(true);
	return await resp.json() as AgentDirState;
}

async function openAgentDirMaintenance(page: Page) {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/general");
	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

	await page.getByRole("button", { name: "Maintenance" }).click();
	await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toContain("/maintenance");

	const section = page.locator(tid("agent-dir-settings"));
	await expect(section).toBeVisible({ timeout: 10_000 });
	await expect(section.getByRole("heading", { name: /Agent Directory/i })).toBeVisible();
	return section;
}

async function waitForAgentDirResponse(page: Page, pathSuffix: string, method: string) {
	return page.waitForResponse((resp) =>
		resp.url().includes(pathSuffix) && resp.request().method() === method,
	);
}

function seedMigrationFiles(activeDir: string, pendingDir: string) {
	mkdirSync(join(activeDir, "sessions"), { recursive: true });
	mkdirSync(join(activeDir, "bin"), { recursive: true });
	writeFileSync(join(activeDir, "sessions", "agent-dir-e2e.jsonl"), "source transcript\n");
	writeFileSync(join(activeDir, "models.json"), JSON.stringify({ marker: "source-models" }));
	writeFileSync(join(activeDir, "settings.json"), JSON.stringify({ marker: "source-settings" }));
	writeFileSync(join(activeDir, "google-code-assist.json"), JSON.stringify({ marker: "source-gca" }));
	writeFileSync(join(activeDir, "bin", "rg"), "source rg\n");

	mkdirSync(join(pendingDir, "bin"), { recursive: true });
	writeFileSync(join(pendingDir, "models.json"), JSON.stringify({ marker: "destination-existing-models" }));
	writeFileSync(join(pendingDir, "bin", "rg"), "destination existing rg\n");
}

test.describe("Settings → Maintenance agent directory", () => {
	test("shows restart-gated agent-dir state, validates paths, migrates with skip/overwrite, and persists pending state", async ({ page, gateway }, testInfo) => {
		// This spec intentionally pins the UI contract before the feature branch is merged.
		// Expected initial failure: the agent-dir Settings section/API may not exist yet.
		const pendingDir = join(dirname(gateway.bobbitDir), `agent-dir-pending-${testInfo.workerIndex}-${Date.now()}`);
		const insideWorktreeDir = join(gateway.bobbitDir, "unsafe-agent-dir");

		try {
			let section = await openAgentDirMaintenance(page);
			const state = await readAgentDirState();
			const activeDir = pickPath(state, "activePath", "active.path", "active.dir", "startup.path", "startup.dir");
			const defaultDir = pickPath(state, "defaultPath", "defaultDir", "active.defaultDir", "startup.defaultDir");
			const nextStartDir = pickPath(state, "nextStartPath", "nextStart.path", "nextStart.dir", "pendingPath");
			const source = pickText(state, "activeSource", "source", "active.source", "startup.source");

			seedMigrationFiles(activeDir, pendingDir);

			await expect(section.locator(tid("agent-dir-active-path"))).toContainText(activeDir);
			await expect(section.locator(tid("agent-dir-source"))).toContainText(source);
			await expect(section.locator(tid("agent-dir-default-path"))).toContainText(defaultDir);
			await expect(section.locator(tid("agent-dir-next-start-path"))).toContainText(nextStartDir);
			await expect(section.locator(tid("agent-dir-pending-path"))).toContainText(/none|not set|default/i);

			const input = section.locator(tid("agent-dir-path-input"));
			await input.fill(insideWorktreeDir);
			const validation = waitForAgentDirResponse(page, "/api/agent-dir/validate", "POST");
			await section.locator(tid("agent-dir-validate-button")).click();
			await validation;
			await expect(section.locator(tid("agent-dir-validation-error"))).toContainText(/INSIDE_WORKTREE|inside (the )?(git )?worktree|inside (the )?project/i);

			await input.fill(pendingDir);
			const save = waitForAgentDirResponse(page, "/api/agent-dir/pending", "PUT");
			await section.locator(tid("agent-dir-save-button")).click();
			await save;

			await expect(section.locator(tid("agent-dir-pending-path"))).toContainText(pendingDir, { timeout: 10_000 });
			await expect(section.locator(tid("agent-dir-guidance"))).toContainText(activeDir);
			await expect(section.locator(tid("agent-dir-guidance"))).toContainText(pendingDir);
			await expect(section.locator(tid("agent-dir-guidance"))).toContainText(/restart|next start|env override|BOBBIT_AGENT_DIR/i);

			const migrationCard = section.locator(tid("agent-dir-migration-card"));
			await expect(migrationCard).toBeVisible({ timeout: 10_000 });
			await expect(migrationCard).toContainText(/copy/i);
			await expect(migrationCard).toContainText(/skip existing/i);

			let migrate = waitForAgentDirResponse(page, "/api/agent-dir/migrate", "POST");
			await migrationCard.locator(tid("agent-dir-migrate-button")).click();
			await migrate;
			let report = migrationCard.locator(tid("agent-dir-migration-report"));
			await expect(report).toContainText(/skipped/i, { timeout: 10_000 });
			await expect(report).toContainText("models.json");
			expect(readFileSync(join(pendingDir, "models.json"), "utf-8")).toContain("destination-existing-models");

			await migrationCard.locator(tid("agent-dir-overwrite-checkbox")).check();
			migrate = waitForAgentDirResponse(page, "/api/agent-dir/migrate", "POST");
			await migrationCard.locator(tid("agent-dir-migrate-button")).click();
			await migrate;
			report = migrationCard.locator(tid("agent-dir-migration-report"));
			await expect(report).toContainText(/overwritten/i, { timeout: 10_000 });
			await expect(report).toContainText("models.json");
			expect(readFileSync(join(pendingDir, "models.json"), "utf-8")).toContain("source-models");

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, "#/settings/system/maintenance");
			section = page.locator(tid("agent-dir-settings"));
			await expect(section).toBeVisible({ timeout: 10_000 });
			await expect(section.locator(tid("agent-dir-active-path"))).toContainText(activeDir);
			await expect(section.locator(tid("agent-dir-pending-path"))).toContainText(pendingDir);
			await expect(section.locator(tid("agent-dir-guidance"))).toContainText(/restart|next start|env override|BOBBIT_AGENT_DIR/i);
			await expect(section.locator(tid("agent-dir-migration-card"))).toBeVisible();
		} finally {
			rmSync(pendingDir, { recursive: true, force: true });
		}
	});
});

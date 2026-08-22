import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import {
	apiFetch,
	createSession,
	defaultProject,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	test,
	waitForSessionStatus,
} from "../_helpers/journey-fixture.js";

const SOURCE_DIR = fileURLToPath(new URL("../fixtures/host-sprite", import.meta.url));
const PACK_NAME = "host-sprite-fixture";
const SESSION_COLOR_INDEX = 8;
const SESSION_HUE = 40;
const STAFF_COLOR_INDEX = 12;
const STAFF_HUE = 100;

type StaffRecord = { id: string; currentSessionId?: string };
type MainSprite = { filter: string; imageCount: number; accessorySrc: string };
type PanelSprite = {
	filter: string;
	hueVariable: string;
	blobClasses: string;
	canvasAnimationName: string;
	runningAnimationNames: string[];
	accessoryVisible: boolean;
	canvasFrame: string;
};

async function responseText(response: Response): Promise<string> {
	return response.clone().text().catch(() => "");
}

async function addFixtureSource(): Promise<string> {
	const response = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	if (response.status === 409) {
		const list = await apiFetch("/api/marketplace/sources");
		const source = ((await list.json()).sources ?? []).find((item: { id: string; url: string }) => item.url === SOURCE_DIR);
		expect(source, "the existing Host sprite fixture source should be discoverable").toBeTruthy();
		return source.id;
	}
	expect(response.status, `fixture source registration failed: ${await responseText(response)}`).toBe(201);
	return (await response.json()).source.id;
}

async function installFixturePack(sourceId: string, projectId: string): Promise<void> {
	const response = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK_NAME, scope: "project", projectId }),
	});
	expect(response.status, `fixture pack installation failed: ${await responseText(response)}`).toBe(201);
}

async function uninstallFixturePack(projectId: string): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "project", projectId, packName: PACK_NAME }),
	}).catch(() => {});
}

async function patchSessionAppearance(sessionId: string, colorIndex: number, accessory: string): Promise<void> {
	const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "PATCH",
		body: JSON.stringify({ colorIndex, accessory }),
	});
	expect(response.status, `session appearance patch failed: ${await responseText(response)}`).toBe(200);
}

function panelSprite(page: Page, key: string): Locator {
	return page.locator(`[data-fixture-sprite="${key}"]`);
}

async function capturePanelSprite(sprite: Locator, accessoryClass: string): Promise<PanelSprite> {
	return sprite.evaluate((root, expectedAccessoryClass) => {
		const blob = root.querySelector<HTMLElement>(".bobbit-blob");
		const canvas = root.querySelector<HTMLCanvasElement>("canvas.bobbit-blob__sprite");
		if (!blob || !canvas) throw new Error("Host sprite did not render the canonical Bobbit canvas");
		const accessory = root.querySelector<HTMLElement>(expectedAccessoryClass);
		const accessoryStyle = accessory ? getComputedStyle(accessory) : undefined;
		const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
		const hueVariable = elements
			.map(element => getComputedStyle(element).getPropertyValue("--bobbit-hue-rotate").trim())
			.find(Boolean) ?? "";
		return {
			filter: getComputedStyle(blob).filter,
			hueVariable,
			blobClasses: blob.className,
			canvasAnimationName: getComputedStyle(canvas).animationName,
			runningAnimationNames: root.getAnimations({ subtree: true })
				.filter(animation => animation.playState === "running" || animation.pending)
				.map(animation => (animation as Animation & { animationName?: string }).animationName ?? "")
				.filter(Boolean),
			accessoryVisible: !!accessoryStyle
				&& accessoryStyle.display !== "none"
				&& accessoryStyle.visibility !== "hidden"
				&& Number(accessoryStyle.opacity) > 0,
			canvasFrame: canvas.toDataURL(),
		};
	}, accessoryClass);
}

async function ensureSidebarRow(page: Page, sessionId: string, staff = false): Promise<Locator> {
	const row = page.locator(`[data-testid="sidebar-expanded"] button[data-session-id="${sessionId}"]`).first();
	if (staff && !(await row.isVisible().catch(() => false))) {
		const header = page.getByTestId("sidebar-staff-header").first();
		if (await header.isVisible().catch(() => false)) await header.click();
	}
	await expect(row, `main application should render ${staff ? "staff" : "session"} identity`).toBeVisible({ timeout: 20_000 });
	return row;
}

async function captureMainSprite(row: Locator): Promise<MainSprite> {
	return row.evaluate((root) => {
		const sprite = Array.from(root.querySelectorAll<HTMLElement>("span")).find((element) => {
			const style = getComputedStyle(element);
			return style.position === "relative" && style.overflow === "hidden" && element.querySelector(":scope > img");
		});
		if (!sprite) throw new Error("main application row did not contain a canonical Bobbit sprite");
		const images = Array.from(sprite.querySelectorAll<HTMLImageElement>(":scope > img"));
		const accessory = images.find(image => image.className.includes("bobbit-sidebar-accessory--front"))
			?? images.find(image => image.className.includes("bobbit-sidebar-accessory--right"));
		return {
			filter: getComputedStyle(sprite).filter,
			imageCount: images.length,
			accessorySrc: accessory?.src ?? "",
		};
	});
}

function expectHue(sprite: PanelSprite, degrees: number): void {
	const evidence = `${sprite.hueVariable} ${sprite.filter}`;
	expect(evidence).toContain(`${degrees}deg`);
}

async function expectSpriteParity(
	page: Page,
	sessionId: string,
	staffSessionId: string,
	priorMain?: { session: MainSprite; staff: MainSprite },
): Promise<{ session: MainSprite; staff: MainSprite }> {
	const panel = page.getByTestId("host-sprite-fixture-panel");
	await expect(panel).toHaveAttribute("data-sprites-appended", "true", { timeout: 20_000 });

	for (const label of [
		"Session active avatar", "Session idle avatar", "Session paused avatar", "Session active-static avatar",
		"Staff active avatar", "Staff idle avatar", "Staff paused avatar", "Staff active-static avatar",
	]) {
		await expect(page.getByRole("img", { name: label, exact: true }), `${label} should use the caller label as its accessible name`).toBeVisible();
	}

	const [sessionMain, staffMain] = await Promise.all([
		captureMainSprite(await ensureSidebarRow(page, sessionId)),
		captureMainSprite(await ensureSidebarRow(page, staffSessionId, true)),
	]);
	expect(sessionMain.filter).toContain(`hue-rotate(${SESSION_HUE}deg)`);
	expect(staffMain.filter).toContain(`hue-rotate(${STAFF_HUE}deg)`);
	expect(sessionMain.imageCount).toBeGreaterThan(1);
	expect(staffMain.imageCount).toBeGreaterThan(1);
	expect(sessionMain.accessorySrc).toBeTruthy();
	expect(staffMain.accessorySrc).toBeTruthy();
	expect(sessionMain.accessorySrc, "crown and ponytail must remain distinct main-app identities").not.toBe(staffMain.accessorySrc);
	if (priorMain) {
		expect(sessionMain.accessorySrc, "session accessory should survive reload").toBe(priorMain.session.accessorySrc);
		expect(staffMain.accessorySrc, "staff accessory should survive reload").toBe(priorMain.staff.accessorySrc);
	}

	const captures = new Map<string, PanelSprite>();
	for (const subject of ["session", "staff"] as const) {
		const accessoryClass = subject === "session" ? ".bobbit-blob__crown" : ".bobbit-blob__ponytail";
		for (const presentation of ["active", "idle", "paused", "active-static"] as const) {
			const key = `${subject}-${presentation}`;
			const sprite = panelSprite(page, key);
			await expect(sprite).toBeVisible();
			const capture = await capturePanelSprite(sprite, accessoryClass);
			expectHue(capture, subject === "session" ? SESSION_HUE : STAFF_HUE);
			expect(capture.accessoryVisible, `${key} should render its persisted accessory`).toBe(true);
			captures.set(key, capture);
		}
	}

	for (const subject of ["session", "staff"] as const) {
		const active = captures.get(`${subject}-active`)!;
		const idle = captures.get(`${subject}-idle`)!;
		const paused = captures.get(`${subject}-paused`)!;
		const staticActive = captures.get(`${subject}-active-static`)!;
		expect(active.blobClasses).not.toContain("bobbit-blob--idle");
		expect(active.canvasAnimationName).toContain("blob-busy-move-canvas");
		expect(active.runningAnimationNames.length).toBeGreaterThan(0);
		expect(idle.blobClasses).toContain("bobbit-blob--idle");
		expect(idle.canvasAnimationName).toContain("blob-idle-eyes-canvas");
		expect(idle.canvasAnimationName).toContain("blob-idle-sleep-breathe-canvas");
		expect(idle.runningAnimationNames.length).toBeGreaterThan(0);
		expect(paused.blobClasses).not.toContain("bobbit-blob--idle");
		expect(paused.canvasAnimationName).toBe("none");
		expect(paused.runningAnimationNames).toEqual([]);
		expect(staticActive.canvasAnimationName).toBe("none");
		expect(staticActive.runningAnimationNames).toEqual([]);
		expect(staticActive.canvasFrame, "static active should use the canonical paused/open rest frame").toBe(paused.canvasFrame);
	}

	for (const presentation of ["active", "idle", "paused", "active-static"] as const) {
		const session = captures.get(`session-${presentation}`)!;
		const staff = captures.get(`staff-${presentation}`)!;
		expect(staff.blobClasses.includes("bobbit-blob--idle")).toBe(session.blobClasses.includes("bobbit-blob--idle"));
		expect(staff.canvasAnimationName).toBe(session.canvasAnimationName);
	}
	return { session: sessionMain, staff: staffMain };
}

test.describe("Journey: Host Bobbit sprite fixture panel", () => {
	test("matches persisted session and staff identity plus canonical states before and after reload", async ({ page }) => {
		test.setTimeout(120_000);
		const project = await defaultProject();
		let sourceId: string | undefined;
		let sessionId: string | undefined;
		let staff: StaffRecord | undefined;

		try {
			sourceId = await addFixtureSource();
			await installFixturePack(sourceId, project.id);
			sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
			await waitForSessionStatus(sessionId, "idle", 30_000);
			await patchSessionAppearance(sessionId, SESSION_COLOR_INDEX, "crown");

			const staffResponse = await apiFetch("/api/staff", {
				method: "POST",
				body: JSON.stringify({
					name: `HostSpriteStaff${Date.now().toString(36)}`,
					description: "Host sprite browser fixture staff identity.",
					systemPrompt: "Remain idle for deterministic Host sprite parity coverage.",
					cwd: project.rootPath,
					projectId: project.id,
					worktree: false,
					sandboxed: false,
					accessory: "ponytail",
				}),
			});
			expect(staffResponse.status, `staff create failed: ${await responseText(staffResponse)}`).toBe(201);
			staff = await staffResponse.json() as StaffRecord;
			expect(staff.currentSessionId, "fixture staff should have a current session for colour resolution").toBeTruthy();
			await waitForSessionStatus(staff.currentSessionId!, "idle", 30_000);
			await patchSessionAppearance(staff.currentSessionId!, STAFF_COLOR_INDEX, "ponytail");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/ext/host-sprite-fixture?staffId=${encodeURIComponent(staff.id)}`);
			const firstMain = await expectSpriteParity(page, sessionId, staff.currentSessionId!);

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/ext/host-sprite-fixture?staffId=${encodeURIComponent(staff.id)}`);
			await expectSpriteParity(page, sessionId, staff.currentSessionId!, firstMain);
		} finally {
			if (staff?.id) await apiFetch(`/api/staff/${encodeURIComponent(staff.id)}`, { method: "DELETE" }).catch(() => {});
			if (staff?.currentSessionId) await deleteSession(staff.currentSessionId).catch(() => {});
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await uninstallFixturePack(project.id);
			if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
		}
	});
});

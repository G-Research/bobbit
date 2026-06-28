import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteSession } from "../e2e-setup.js";
import { createSessionViaUI, openApp } from "./ui-helpers.js";

// Browser E2E for the first-party terminal pack. The WebSocket send spy is a
// test-only observer: it does not feed data back into the app or expose transport
// to pack code, and it lets the spec prove resize travels through host.channels.
test.describe.configure({ mode: "serial" });

const tid = (id: string) => `[data-testid="${id}"]`;
const terminalPanel = () => `${tid("terminal-panel")}`;
const terminalHost = () => `${tid("terminal-xterm")}`;

test.describe("terminal pack panel", () => {
	let sessionId: string | undefined;

	test.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		sessionId = undefined;
	});

	test("opens from session menu, runs commands, resizes, reload-reattaches, kills, restarts, exits, and cleans up @smoke", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1400, height: 900 });
		await installChannelFrameSpy(page);

		const contributions = await listContributions();
		const terminal = contributions.find((p) => p.packId === "terminal");
		expect(terminal?.panels?.some((p) => p.id === "terminal.panel")).toBe(true);
		expect(terminal?.entrypoints?.some((e) => e.kind === "session-menu" && e.label === "Open Terminal")).toBe(true);

		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());

		await openTerminalFromSessionMenu(page);
		await expect(page.locator(terminalPanel())).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /attached|connecting/, { timeout: 20_000 });
		await expect.poll(() => channelSendCount(page, "ext_channel_open"), { timeout: 20_000 }).toBeGreaterThan(0);

		const marker1 = `bobbit_terminal_e2e_${Date.now()}`;
		await typeCommand(page, `echo ${marker1}`);
		await expect(page.locator(terminalHost())).toContainText(marker1, { timeout: 20_000 });

		const resizeBefore = await resizeFrameCount(page);
		await page.setViewportSize({ width: 1200, height: 700 });
		await page.setViewportSize({ width: 1500, height: 950 });
		await expect.poll(() => resizeFrameCount(page), { timeout: 15_000 }).toBeGreaterThan(resizeBefore);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel()), "terminal panel should be restored after reload").toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /attached|connecting/, { timeout: 20_000 });
		await expect.poll(() => channelSendCount(page, "ext_channel_attach"), { timeout: 20_000 }).toBeGreaterThan(0);

		const marker2 = `${marker1}_reattach`;
		await typeCommand(page, `echo ${marker2}`);
		await expect(page.locator(terminalHost())).toContainText(marker2, { timeout: 20_000 });

		await typeCommand(page, "exit");
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /exited|disconnected|idle/, { timeout: 20_000 });

		const openBeforeRestart = await channelSendCount(page, "ext_channel_open");
		const startButton = page.locator(terminalPanel()).getByRole("button", { name: "Start or restart terminal" });
		await expect(startButton).toBeEnabled({ timeout: 20_000 });
		await startButton.click();
		await expect.poll(() => channelSendCount(page, "ext_channel_open"), { timeout: 20_000 }).toBeGreaterThan(openBeforeRestart);
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /attached|connecting/, { timeout: 20_000 });

		const killBefore = await killFrameCount(page);
		await page.locator(terminalPanel()).getByRole("button", { name: "Terminate terminal process" }).click();
		await expect.poll(() => killFrameCount(page), { timeout: 10_000 }).toBeGreaterThan(killBefore);
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /killed|idle|disconnected/, { timeout: 20_000 });

		await page.locator(terminalPanel()).getByRole("button", { name: "Hide terminal panel without killing the process" }).click();
		await expect(page.locator(terminalPanel())).toHaveCount(0, { timeout: 10_000 });
	});
});

async function listContributions(): Promise<Array<{ packId: string; panels: Array<{ id: string }>; entrypoints: Array<{ kind: string; label?: string }>; channelNames?: string[] }>> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs;
}

async function installChannelFrameSpy(page: import("@playwright/test").Page): Promise<void> {
	await page.addInitScript(() => {
		const win = window as any;
		win.__terminalE2E = { sent: [] as any[] };
		const OriginalWebSocket = window.WebSocket;
		window.WebSocket = class BobbitTerminalSpyWebSocket extends OriginalWebSocket {
			send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
				if (typeof data === "string") {
					try {
						const msg = JSON.parse(data);
						if (msg?.type && String(msg.type).startsWith("ext_channel")) {
							win.__terminalE2E.sent.push(msg);
						}
					} catch {
						// Non-JSON websocket payload; ignore.
					}
				}
				return super.send(data as any);
			}
		} as typeof WebSocket;
	});
}

async function openTerminalFromSessionMenu(page: import("@playwright/test").Page): Promise<void> {
	const trigger = page.locator(tid("session-actions-trigger")).first();
	await expect(trigger, "chat header session-actions menu must be available").toBeVisible({ timeout: 10_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
	const launcher = page.locator('sidebar-actions-popover [role="menuitem"]', { hasText: "Open Terminal" }).first();
	await expect(launcher, "the terminal launcher must render in the session menu").toBeVisible({ timeout: 10_000 });
	await launcher.click();
	await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
}

async function typeCommand(page: import("@playwright/test").Page, command: string): Promise<void> {
	await page.locator(terminalHost()).click();
	await page.keyboard.type(command);
	await page.keyboard.press("Enter");
}

async function resizeFrameCount(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => ((window as any).__terminalE2E?.sent ?? []).filter((msg: any) => msg?.type === "ext_channel_send" && msg?.frame?.kind === "json" && msg.frame.data?.op === "resize").length);
}

async function killFrameCount(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => ((window as any).__terminalE2E?.sent ?? []).filter((msg: any) => msg?.type === "ext_channel_send" && msg?.frame?.kind === "json" && msg.frame.data?.op === "kill").length);
}

async function channelSendCount(page: import("@playwright/test").Page, type: string): Promise<number> {
	return page.evaluate((msgType) => ((window as any).__terminalE2E?.sent ?? []).filter((msg: any) => msg?.type === msgType).length, type);
}

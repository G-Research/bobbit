/**
 * Journey: Misc: session chrome, notifications, retry state, and responsive smoke.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../../../tests2/browser/_helpers/journey-fixture.js";
import { apiFetch, defaultProject } from "../../../tests2/browser/_helpers/journey-fixture.js";
import { createUploadedAttachmentExtension } from "../../../defaults/tools/attachments/extension.js";

test.describe("Journey: Notification Policy", () => {
	test("app renders without notification errors and settings route is reachable", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("fresh session has unseen dot; mark-read via API removes it after reload", async ({ page }) => {
		const proj = await defaultProject();
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json() as { id: string };
		const sessionId = sess.id;
		try {
			await openApp(page);
			await navigateToHash(page, "#/");
			const row = page.locator(`[data-session-id="${sessionId}"]`).first();
			await expect(row).toBeVisible({ timeout: 15_000 });
			await expect(row.locator(".unseen-dot")).toHaveCount(1, { timeout: 15_000 });
			const markResp = await apiFetch(`/api/sessions/${sessionId}/mark-read`, { method: "POST" });
			expect(markResp.status).toBe(200);
			await openApp(page);
			await navigateToHash(page, "#/");
			const rowAfter = page.locator(`[data-session-id="${sessionId}"]`).first();
			await expect(rowAfter).toBeVisible({ timeout: 15_000 });
			await expect(rowAfter.locator(".unseen-dot")).toHaveCount(0, { timeout: 15_000 });
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("team-member session patch hides the unread dot", async ({ page }) => {
		const proj = await defaultProject();
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json() as { id: string };
		const sessionId = sess.id;
		try {
			await openApp(page);
			await navigateToHash(page, "#/");
			const row = page.locator(`[data-session-id="${sessionId}"]`).first();
			await expect(row).toBeVisible({ timeout: 15_000 });
			await expect(row.locator(".unseen-dot")).toHaveCount(1, { timeout: 15_000 });
			await page.evaluate(() => {
				const state: any = (window as any).__bobbitState;
				if (state?.sessionPollTimer) { clearInterval(state.sessionPollTimer); state.sessionPollTimer = null; }
			});
			await page.evaluate(({ sid }: { sid: string }) => {
				const state: any = (window as any).__bobbitState;
				const s = state?.gatewaySessions?.find((x: any) => x.id === sid);
				if (s) { s.role = "coder"; s.teamGoalId = "fake-goal"; s.teamLeadSessionId = "fake-lead"; }
				(window as any).__bobbitRenderApp?.();
				return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
			}, { sid: sessionId });
			await expect(page.locator(`[data-session-id="${sessionId}"] .unseen-dot`)).toHaveCount(0, { timeout: 15_000 });
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});

test.describe("Journey: Uploaded File Attachments", () => {
	test("arbitrary text and binary attachments reach model and bounded tool reads, survive reload, and are purged", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const sessionId = await createSession();
		const typedPrompt = "What have I attached?";
		const textFileName = "notes with spaces & unicode-©.custom";
		const escapedTextFileName = "notes with spaces &amp; unicode-©.custom";
		const textBytes = Buffer.from("ARBITRARY_ATTACHMENT_MARKER");
		const binaryBytes = Buffer.from([0x00, 0xff, 0x01, 0x02]);
		const pointerPattern = "bobbit-attachment:v1:[a-f0-9]{64}:[a-f0-9]{64}:[A-Za-z0-9_-]{24}";
		let deleted = false;

		const attachmentTool = (() => {
			let registered: any;
			createUploadedAttachmentExtension()({
				registerTool: (tool: unknown) => { registered = tool; },
			} as any);
			expect(registered?.name).toBe("session_attachment");
			return registered;
		})();
		const sessionSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
		const executeAttachmentTool = async (params: Record<string, unknown>): Promise<any> => {
			const previousSessionId = process.env.BOBBIT_SESSION_ID;
			const previousSessionSecret = process.env.BOBBIT_SESSION_SECRET;
			process.env.BOBBIT_SESSION_ID = sessionId;
			process.env.BOBBIT_SESSION_SECRET = sessionSecret;
			try {
				return await attachmentTool.execute(`attachment-${Date.now()}`, params);
			} finally {
				if (previousSessionId === undefined) delete process.env.BOBBIT_SESSION_ID;
				else process.env.BOBBIT_SESSION_ID = previousSessionId;
				if (previousSessionSecret === undefined) delete process.env.BOBBIT_SESSION_SECRET;
				else process.env.BOBBIT_SESSION_SECRET = previousSessionSecret;
			}
		};
		const resultBody = (result: any): any => {
			expect(result?.isError, result?.content?.[0]?.text).not.toBe(true);
			return JSON.parse(result.content[0].text);
		};
		const modelText = (message: any): string => Array.isArray(message?.content)
			? message.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("")
			: typeof message?.content === "string" ? message.content : "";

		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			const input = page.locator('message-editor input[type="file"]');
			await expect(input).toHaveAttribute("accept", "");
			await input.setInputFiles([
				{ name: textFileName, mimeType: "application/x-custom", buffer: textBytes },
				{ name: "payload.opaque", mimeType: "application/x-opaque", buffer: binaryBytes },
			]);
			const composerTiles = page.locator("message-editor attachment-tile");
			await expect(composerTiles).toHaveCount(2, { timeout: 10_000 });
			expect(await composerTiles.nth(0).evaluate((element: any) => element.attachment.fileName)).toBe(textFileName);
			expect(await composerTiles.nth(0).evaluate((element: any) => element.attachment.id)).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
			expect(await composerTiles.nth(1).evaluate((element: any) => element.attachment.fileName)).toBe("payload.opaque");

			const textarea = page.locator("message-editor textarea").first();
			await textarea.fill(typedPrompt);
			await textarea.press("Enter");
			await waitForSessionStatus(sessionId, "idle", 20_000);

			const sentPrompt = page.locator("user-message").filter({ hasText: typedPrompt }).last();
			await expect(sentPrompt).toBeVisible({ timeout: 15_000 });
			await expect(sentPrompt.locator("attachment-tile")).toHaveCount(2);
			expect(await sentPrompt.locator("markdown-block").evaluate((element: any) => element.content)).toBe(typedPrompt);
			await expect(sentPrompt).not.toContainText("ARBITRARY_ATTACHMENT_MARKER");
			await expect(sentPrompt).not.toContainText("bobbit-attachment:v1:");

			const rpc = gateway.sessionManager.getSession(sessionId)?.rpcClient;
			const messagesResponse = await rpc?.getMessages();
			const messages = messagesResponse?.data?.messages ?? messagesResponse?.data ?? [];
			const dispatchedText = [...messages].reverse()
				.filter((message: any) => message?.role === "user")
				.map(modelText)
				.find((text: string) => text.startsWith(typedPrompt));
			expect(dispatchedText, "mock agent must receive the model-only attachment context").toBeTruthy();
			expect(dispatchedText).toContain("ARBITRARY_ATTACHMENT_MARKER");
			expect(dispatchedText).toContain(`filename="${escapedTextFileName}"`);
			expect(dispatchedText).toContain('filename="payload.opaque"');
			expect(dispatchedText).toContain("Binary content is not embedded in the prompt");
			expect(dispatchedText).not.toContain(binaryBytes.toString("base64"));

			const notesPointer = new RegExp(`filename="notes with spaces &amp; unicode-©\\.custom"[^>]*pointer="(${pointerPattern})"`).exec(dispatchedText!)?.[1];
			const binaryPointer = new RegExp(`filename="payload\\.opaque"[^>]*pointer="(${pointerPattern})"`).exec(dispatchedText!)?.[1];
			expect(notesPointer).toBeTruthy();
			expect(binaryPointer).toBeTruthy();
			expect(notesPointer).not.toBe(binaryPointer);

			const listed = resultBody(await executeAttachmentTool({ operation: "list", pointer: notesPointer }));
			expect(listed.attachments.map((attachment: any) => ({
				pointer: attachment.pointer,
				fileName: attachment.fileName,
				size: attachment.size,
			}))).toEqual([
				{ pointer: notesPointer, fileName: textFileName, size: textBytes.length },
				{ pointer: binaryPointer, fileName: "payload.opaque", size: binaryBytes.length },
			]);
			const textRange = resultBody(await executeAttachmentTool({ operation: "read", pointer: notesPointer, offset: 10, length: 10 }));
			expect(textRange).toMatchObject({ encoding: "base64", offset: 10, bytesRead: 10, nextOffset: 20, eof: false });
			expect(Buffer.from(textRange.data, "base64")).toEqual(textBytes.subarray(10, 20));
			const binaryRange = resultBody(await executeAttachmentTool({ operation: "read", pointer: binaryPointer, offset: 1, length: 2 }));
			expect(binaryRange).toMatchObject({ encoding: "base64", offset: 1, bytesRead: 2, nextOffset: 3, eof: false });
			expect(Buffer.from(binaryRange.data, "base64")).toEqual(binaryBytes.subarray(1, 3));

			await page.reload({ waitUntil: "domcontentloaded" });
			const reloadedPrompt = page.locator("user-message").filter({ hasText: typedPrompt }).last();
			await expect(reloadedPrompt).toBeVisible({ timeout: 15_000 });
			const reloadedTiles = reloadedPrompt.locator("attachment-tile");
			await expect(reloadedTiles).toHaveCount(2);
			expect(await reloadedTiles.nth(0).evaluate((element: any) => element.attachment.fileName)).toBe(textFileName);
			expect(await reloadedTiles.nth(1).evaluate((element: any) => element.attachment.fileName)).toBe("payload.opaque");
			expect(await reloadedPrompt.locator("markdown-block").evaluate((element: any) => element.content)).toBe(typedPrompt);
			const reloadedList = resultBody(await executeAttachmentTool({ operation: "list", pointer: binaryPointer }));
			expect(reloadedList.attachments.map((attachment: any) => attachment.pointer)).toEqual([notesPointer, binaryPointer]);
			const reloadedRange = resultBody(await executeAttachmentTool({ operation: "read", pointer: notesPointer, offset: 10, length: 10 }));
			expect(reloadedRange.data).toBe(textRange.data);
			expect(reloadedRange.pointer).toBe(notesPointer);
			const reloadedBinaryRange = resultBody(await executeAttachmentTool({ operation: "read", pointer: binaryPointer, offset: 1, length: 2 }));
			expect(reloadedBinaryRange.data).toBe(binaryRange.data);
			expect(reloadedBinaryRange.pointer).toBe(binaryPointer);

			await deleteSession(sessionId);
			deleted = true;
			const staleRead = await executeAttachmentTool({ operation: "read", pointer: binaryPointer, offset: 0, length: 1 });
			expect(staleRead.isError).toBe(true);
			expect(staleRead.content[0].text).toMatch(/forbidden|unavailable/i);
			await navigateToHash(page, "#/");
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0, { timeout: 15_000 });
			await expect(page.locator("user-message attachment-tile")).toHaveCount(0);
			expect(await page.locator("body").innerText()).not.toContain(textFileName);
			expect(await page.locator("body").innerText()).not.toContain("payload.opaque");
		} finally {
			if (!deleted) await deleteSession(sessionId).catch(() => {});
		}
	});
});

test.describe("Journey: Footer Working Directory", () => {
	test.use({ permissions: ["clipboard-read", "clipboard-write"] });

	test("desktop footer shows the full path and copies it", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const project = await defaultProject();
		const sessionId = await createSession({ cwd: project.rootPath, projectId: project.id });
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const cwdPath = page.getByTestId("footer-cwd-path");
			await expect(cwdPath).toBeVisible({ timeout: 15_000 });
			await expect(cwdPath).toHaveText(project.rootPath);
			await expect(cwdPath).toHaveAttribute("title", project.rootPath);

			const copyButton = page.getByTestId("footer-cwd-copy");
			await copyButton.click();
			await expect(copyButton).toHaveAttribute("aria-label", "Working directory copied");
			await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).toBe(project.rootPath);

			await page.reload();
			await expect(page.getByTestId("footer-cwd-path")).toHaveText(project.rootPath, { timeout: 20_000 });
			await expect(page.getByTestId("footer-cwd-copy")).toBeVisible();
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
test.describe("Journey: Dynamic Panels", () => {
	test("session route renders for dynamic panel scenario", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Mobile Layout", () => {
	test("app renders at mobile viewport", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test.skip("sidebar-edge visible at mobile viewport", async ({ page }) => {
		// Skipped: .sidebar-edge is typically hidden/collapsed at mobile viewport width.
		// Mobile sidebar behaviour is tested by geometry-fixture specs.
		await page.setViewportSize({ width: 390, height: 844 });
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});
// Ported from auto-retry-banner.spec.ts (audit: misc GAP): an injected
// auto_retry_pending event renders the banner with its data-* attributes.
test.describe("Journey: Auto-Retry Banner", () => {
	test("auto_retry_pending renders the banner with reason/attempt/delay", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const banner = page.locator('[data-testid="auto-retry-banner"]');
			await expect(banner).toHaveCount(0);
			// Inject the same event the server broadcasts from maybeAutoRetryTransient.
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "auto_retry_pending", reason: "provider-overload",
					retryDelayMs: 4000, attempt: 3, scheduledAt: Date.now(), error: "overloaded_error",
				});
			});
			await expect(banner).toBeVisible({ timeout: 10_000 });
			await expect(banner).toHaveAttribute("data-reason", "provider-overload");
			await expect(banner).toHaveAttribute("data-attempt", "3");
			await expect(banner).toHaveAttribute("data-retry-delay-ms", "4000");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

// A terminal non-retryable turn with queued work must visibly require a human
// retry, and the next turn must clear the parked-work state.
test.describe("Journey: Manual-Retry Required Banner", () => {
	test("survives a session reload and clears when the next turn starts", async ({ page, gateway }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			const session = gateway.sessionManager?.getSession(sessionId);
			expect(session, "manual-retry journey requires a live in-process session").toBeTruthy();
			session!.manualRetryRequired = true;
			session!.lastTurnErrorMessage = "provider request failed: api_key=sk-or-manualretrysecret";
			session!.promptQueue.enqueue("parked work");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const banner = page.locator('[data-testid="manual-retry-required-banner"]');
			await expect(banner).toBeVisible({ timeout: 10_000 });
			await expect(banner).toContainText("Manual Retry is required.");

			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(banner).toBeVisible({ timeout: 10_000 });

			await navigateToHash(page, "#/");
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(banner).toBeVisible({ timeout: 10_000 });

			for (const listener of [...session!.rpcClient.eventListeners]) listener({ type: "agent_start" });
			await expect(banner).toHaveCount(0, { timeout: 10_000 });
			await expect.poll(() => session!.manualRetryRequired).toBe(false);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
test.describe("Journey: Footer Image Model", () => {
	test("footer shows the resolved image-model id (default gpt-image-2)", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const footer = page.locator("[data-testid='footer-image-model-id']").first();
			await expect(footer).toBeVisible({ timeout: 15_000 });
			await expect(footer).toHaveText("gpt-image-2", { timeout: 10_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

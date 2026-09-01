import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { GatewayInfo } from "../../../tests2/browser/gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	sendMessage,
	test,
	waitForAgentResponse,
	waitForSessionStatus,
} from "../../../tests2/browser/_helpers/journey-fixture.js";
import { harnessDefaultProjectRoot, projectStateDirForRoot } from "../../../tests2/browser/e2e-setup.js";

const RETIRED_MODEL = {
	provider: "retired-browser-provider",
	id: "retired-browser-model",
} as const;
const HISTORY_MARKER = "MODEL_RECOVERY_HISTORY_MARKER";
// Opt the in-process mock into Pi's production image-echo shape so the
// recovered draft proves its attachment survives the full authoritative round trip.
const BLOCKED_DRAFT = "MODEL_RECOVERY_BLOCKED_DRAFT ECHO_IMAGE_BLOCK";
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type PersistedSession = {
	id: string;
	modelProvider?: string;
	modelId?: string;
	effectiveThinkingLevel?: string;
	agentSessionFile?: string;
};

type SessionsFile = PersistedSession[] | {
	version?: number;
	epoch?: number;
	sessions: PersistedSession[];
};

type ApiModel = {
	provider: string;
	id: string;
	sessionSelectable?: boolean;
};

function sessionsFilePath(): string {
	return join(projectStateDirForRoot(harnessDefaultProjectRoot()), "sessions.json");
}

function readSessionsFile(): SessionsFile {
	return JSON.parse(readFileSync(sessionsFilePath(), "utf8")) as SessionsFile;
}

function rowsOf(file: SessionsFile): PersistedSession[] {
	return Array.isArray(file) ? file : file.sessions;
}

function persistedRow(sessionId: string): PersistedSession | undefined {
	return rowsOf(readSessionsFile()).find((row) => row.id === sessionId);
}

function retirePersistedModel(sessionId: string): { transcriptFile: string; transcript: string } {
	const file = readSessionsFile();
	const row = rowsOf(file).find((candidate) => candidate.id === sessionId);
	if (!row) throw new Error(`Persisted session ${sessionId} is missing`);
	if (!row.agentSessionFile) throw new Error(`Persisted session ${sessionId} has no transcript path`);

	const transcript = readFileSync(row.agentSessionFile, "utf8");
	if (!transcript.includes(HISTORY_MARKER)) {
		throw new Error("Historical prompt was not durable before the cold restart");
	}
	row.modelProvider = RETIRED_MODEL.provider;
	row.modelId = RETIRED_MODEL.id;
	writeFileSync(sessionsFilePath(), JSON.stringify(file, null, 2), "utf8");
	return { transcriptFile: row.agentSessionFile, transcript };
}

async function listedSession(sessionId: string): Promise<any> {
	const response = await apiFetch("/api/sessions");
	expect(response.status).toBe(200);
	const body = await response.json() as { sessions?: any[] };
	return body.sessions?.find((session) => session.id === sessionId);
}

async function pageRecoveryCondition(page: Page): Promise<unknown> {
	return page.evaluate(() => {
		const win = window as any;
		const appState = win.bobbitState ?? win.__bobbitState;
		return appState?.remoteAgent?.state?.condition ?? null;
	});
}

async function restartGateway(gateway: GatewayInfo): Promise<void> {
	await gateway.restart();
	await expect.poll(
		async () => {
			try {
				return (await apiFetch("/health")).status === 200;
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, intervals: [250], message: "gateway should be healthy after cold restart" },
	).toBe(true);
}

test.describe("Journey: unavailable session model recovery", () => {
	test("keeps history and composer draft recoverable until a replacement model is verified", async ({ page, gateway }) => {
		test.setTimeout(120_000);

		const sentFrames: Array<Record<string, unknown>> = [];
		page.on("websocket", (socket) => {
			socket.on("framesent", (event) => {
				try {
					const payload = typeof event.payload === "string"
						? event.payload
						: event.payload.toString("utf8");
				sentFrames.push(JSON.parse(payload) as Record<string, unknown>);
				} catch {
					// Ignore non-JSON transport frames.
				}
			});
		});

		let sessionId: string | undefined;
		let gatewayRunning = true;
		try {
			const modelsResponse = await apiFetch("/api/models");
			expect(modelsResponse.status).toBe(200);
			const currentModels = await modelsResponse.json() as ApiModel[];
			expect(currentModels.some((model) =>
				model.provider === RETIRED_MODEL.provider && model.id === RETIRED_MODEL.id,
			), "the retired tuple must be authoritatively absent from the current catalog").toBe(false);

			sessionId = await createSession();
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			await sendMessage(page, HISTORY_MARKER);
			await expect(page.locator("user-message").filter({ hasText: HISTORY_MARKER }).first()).toBeVisible({ timeout: 20_000 });
			await waitForAgentResponse(page);
			await waitForSessionStatus(sessionId, "idle");

			await expect.poll(
				() => persistedRow(sessionId!)?.agentSessionFile,
				{ timeout: 15_000, message: "historical session should persist its transcript path" },
			).toEqual(expect.any(String));
			const original = persistedRow(sessionId)!;
			const replacement = currentModels.find((model) =>
				model.provider === original.modelProvider
				&& model.id === original.modelId
				&& model.sessionSelectable !== false,
			);
			expect(replacement, "the original model should remain a current session-selectable replacement").toBeTruthy();

			await gateway.crash();
			gatewayRunning = false;
			const durable = retirePersistedModel(sessionId);
			await gateway.restart();
			gatewayRunning = true;
			await expect.poll(
				async () => {
					try {
						return (await apiFetch("/health")).status === 200;
					} catch {
						return false;
					}
				},
				{ timeout: 20_000, intervals: [250], message: "gateway should recover after retired-model restart" },
			).toBe(true);

			await expect.poll(() => listedSession(sessionId!), {
				timeout: 20_000,
				message: "retired-model session should remain listed with an exact recovery condition",
			}).toMatchObject({
				id: sessionId,
				status: "terminated",
				condition: {
					code: "MODEL_SELECTION_REQUIRED",
					provider: RETIRED_MODEL.provider,
					modelId: RETIRED_MODEL.id,
				},
			});
			expect(gateway.sessionManager?.getSession(sessionId)).toMatchObject({
				dormant: true,
				condition: {
					code: "MODEL_SELECTION_REQUIRED",
					provider: RETIRED_MODEL.provider,
					modelId: RETIRED_MODEL.id,
				},
			});
			const coldRecordResponse = await apiFetch(`/api/sessions/${sessionId}`);
			expect(coldRecordResponse.status).toBe(200);
			const coldRecord = await coldRecordResponse.json() as any;
			expect(coldRecord).toMatchObject({
				modelProvider: RETIRED_MODEL.provider,
				modelId: RETIRED_MODEL.id,
				condition: {
					code: "MODEL_SELECTION_REQUIRED",
					provider: RETIRED_MODEL.provider,
					modelId: RETIRED_MODEL.id,
				},
			});
			expect(coldRecord.restoreError, "expected recovery must not be a generic retry-on-restart failure").toBeFalsy();
			expect(readFileSync(durable.transcriptFile, "utf8")).toBe(durable.transcript);

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator("user-message").filter({ hasText: HISTORY_MARKER }).first()).toBeVisible({ timeout: 20_000 });

			const banner = page.getByTestId("model-selection-required-banner");
			await expect(banner).toBeVisible({ timeout: 20_000 });
			await expect(banner).toHaveAttribute("data-provider", RETIRED_MODEL.provider);
			await expect(banner).toHaveAttribute("data-model-id", RETIRED_MODEL.id);
			await expect(banner).toContainText(`${RETIRED_MODEL.provider}/${RETIRED_MODEL.id}`);
			await expect.poll(() => pageRecoveryCondition(page), { timeout: 20_000 }).toEqual({
				code: "MODEL_SELECTION_REQUIRED",
				provider: RETIRED_MODEL.provider,
				modelId: RETIRED_MODEL.id,
			});
			await expect(page.getByTestId("manual-retry-required-banner")).toHaveCount(0);
			await expect(page.getByTestId("auto-retry-banner")).toHaveCount(0);

			const editor = page.locator("message-editor").first();
			const textarea = editor.locator("textarea");
			await editor.locator('input[type="file"]').setInputFiles({
				name: "recovery-draft.png",
				mimeType: "image/png",
				buffer: Buffer.from(PNG_B64, "base64"),
			});
			await expect(editor.locator("attachment-tile")).toHaveCount(1);
			await textarea.fill(BLOCKED_DRAFT);
			const transcriptBeforeBlockedSend = readFileSync(durable.transcriptFile, "utf8");
			await textarea.press("Enter");

			await expect(page.getByTestId("composer-model-selection-error")).toHaveText("Choose a replacement model before sending.");
			await expect(textarea).toHaveValue(BLOCKED_DRAFT);
			await expect(editor.locator("attachment-tile")).toHaveCount(1);
			await expect(page.locator("user-message").filter({ hasText: BLOCKED_DRAFT })).toHaveCount(0);
			expect(sentFrames.filter((frame) => frame.type === "prompt" && frame.text === BLOCKED_DRAFT)).toHaveLength(0);
			expect(readFileSync(durable.transcriptFile, "utf8")).toBe(transcriptBeforeBlockedSend);

			await page.getByTestId("choose-replacement-model").click();
			const selector = page.locator("agent-model-selector");
			await expect(selector.getByText("Select Model").first()).toBeVisible({ timeout: 15_000 });
			await selector.getByPlaceholder("Search models...").fill(replacement!.id);
			const replacementItem = selector
				.locator(`[data-model-item][data-model-id="${replacement!.id}"][data-session-unavailable="false"]`)
				.filter({ hasText: replacement!.provider })
				.first();
			await expect(replacementItem, "current selectable replacement should remain available in the existing picker").toBeVisible({ timeout: 15_000 });
			await replacementItem.click();
			await expect.poll(
				() => sentFrames.find((frame) =>
					frame.type === "set_model"
					&& frame.provider === replacement!.provider
					&& frame.modelId === replacement!.id,
				),
				{ timeout: 15_000, message: "picker should send the selected replacement tuple" },
			).toMatchObject({
				type: "set_model",
				provider: replacement!.provider,
				modelId: replacement!.id,
			});
			await expect.poll(
				async () => {
					const response = await apiFetch(`/api/sessions/${sessionId}`);
					return response.ok ? response.json() : null;
				},
				{ timeout: 30_000, message: "verified replacement tuple should become durable" },
			).toMatchObject({ modelProvider: replacement!.provider, modelId: replacement!.id });
			const recoveredRecordResponse = await apiFetch(`/api/sessions/${sessionId}`);
			expect(recoveredRecordResponse.status).toBe(200);
			const recoveredRecord = await recoveredRecordResponse.json() as any;
			expect(recoveredRecord.condition, "direct session projection must clear only after verified replacement").toBeUndefined();
			await expect.poll(
				async () => (await listedSession(sessionId!))?.condition ?? null,
				{ timeout: 30_000, message: "server listing should publish the cleared recovery condition" },
			).toBeNull();
			await expect.poll(
				() => page.evaluate(() => {
					const win = window as any;
					const appState = win.bobbitState ?? win.__bobbitState;
					const state = appState?.remoteAgent?.state;
					return {
						condition: state?.condition ?? null,
						pending: state?.modelSelectionPending ?? null,
						error: state?.modelSelectionError ?? null,
					};
				}),
				{ timeout: 30_000, message: "browser should receive the verified condition clear" },
			).toEqual({ condition: null, pending: null, error: null });
			await expect(banner).toHaveCount(0);
			await expect(page.getByTestId("footer-model-id")).toHaveText(replacement!.id, { timeout: 20_000 });
			await expect(textarea).toHaveValue(BLOCKED_DRAFT);
			await expect(editor.locator("attachment-tile")).toHaveCount(1);

			const okCountBeforeRecoverySend = await page.getByText("OK", { exact: true }).count();
			await textarea.press("Enter");
			const recoveredUserMessage = page.locator("user-message").filter({ hasText: BLOCKED_DRAFT }).last();
			await expect(recoveredUserMessage).toBeVisible({ timeout: 20_000 });
			await expect(recoveredUserMessage.locator("attachment-tile")).toHaveCount(1);
			await expect.poll(
				() => page.getByText("OK", { exact: true }).count(),
				{ timeout: 20_000, message: "recovered session should accept and answer the retained draft" },
			).toBeGreaterThan(okCountBeforeRecoverySend);
			await waitForSessionStatus(sessionId, "idle");

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("user-message").filter({ hasText: HISTORY_MARKER }).first()).toBeVisible({ timeout: 20_000 });
			const reloadedRecoveredMessage = page.locator("user-message").filter({ hasText: BLOCKED_DRAFT }).last();
			await expect(reloadedRecoveredMessage).toBeVisible({ timeout: 20_000 });
			await expect(page.getByTestId("model-selection-required-banner")).toHaveCount(0);
			await expect(page.getByTestId("footer-model-id")).toHaveText(replacement!.id, { timeout: 20_000 });
		} finally {
			if (!gatewayRunning) {
				await restartGateway(gateway).catch(() => undefined);
			}
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
		}
	});
});

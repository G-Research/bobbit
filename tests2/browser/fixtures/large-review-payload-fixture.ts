import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";

/**
 * Mock-harness integration contract (kept in this one fixture module):
 *
 * - `REVIEW_OPEN_DURABLE_LARGE_20` must run the final authenticated review
 *   persistence/open path for `largeReviewFiles()` and emit its correlated,
 *   payload-free v2 receipt as a real `review_open` result.
 * - the receipt uses the deterministic review/file IDs below so identity can
 *   be checked independently of duplicate display titles;
 * - the `_DELAY:<ms>` form delays delivery while leaving the owner session in
 *   `streaming`, allowing the background-session foreground guard to run.
 *
 * No production selector, endpoint, or mock-trigger assumption should be added
 * directly to the journey; adjust this adapter when integration settles.
 */
export const LARGE_REVIEW_TITLE = "Durable 20-file review";
export const LARGE_REVIEW_ID = "browser-large-review-20";
export const LARGE_REVIEW_FILE_COUNT = 20;
export const LARGE_REVIEW_TOTAL_BYTES = 485 * 1024;
export const LARGE_REVIEW_TRIGGER = "REVIEW_OPEN_DURABLE_LARGE_20";
export const LARGE_REVIEW_DELAYED_TRIGGER = `${LARGE_REVIEW_TRIGGER}_DELAY:2000`;
export const LARGE_REVIEW_TAB_ID = `review:${encodeURIComponent(LARGE_REVIEW_ID)}`;

export const REVIEW_RENDERER_SELECTORS = {
	button: "review-open-button",
	status: "review-open-status",
	error: "review-open-error",
} as const;

export interface LargeReviewFileFixture {
	fileId: string;
	title: string;
	markdown: string;
	bytes: number;
	marker: string;
}

export interface ReviewReceiptV2Fixture {
	action: "review_open";
	version: 2;
	toolCallId: string;
	payloadId: string;
	reviewId: string;
	title: string;
	activeFileId: string;
	replace: boolean;
	totalBytes: number;
	hash: string;
	files: Array<{ fileId: string; title: string; bytes?: number; markdownBytes?: number }>;
	automaticOpen?: { status?: string; ok?: boolean };
	openOutcome?: { status?: string; ok?: boolean };
	open?: { status?: string; ok?: boolean };
}

function padded(index: number): string {
	return String(index).padStart(2, "0");
}

/**
 * Canonical browser payload: exactly 485 KiB of UTF-8 Markdown across twenty
 * files. Files 9 and 10 intentionally share a display title while retaining
 * different opaque identities, preventing title-derived identity shortcuts.
 */
export function largeReviewFiles(): LargeReviewFileFixture[] {
	const bytesPerFile = LARGE_REVIEW_TOTAL_BYTES / LARGE_REVIEW_FILE_COUNT;
	if (!Number.isInteger(bytesPerFile)) throw new Error("large review byte budget must divide evenly");
	return Array.from({ length: LARGE_REVIEW_FILE_COUNT }, (_, offset) => {
		const index = offset + 1;
		const suffix = padded(index);
		const fileId = `browser-large-file-${suffix}`;
		const title = index === 9 || index === 10 ? "Duplicate.md" : `Large file ${suffix}.md`;
		const marker = `LARGE_REVIEW_MARKER_${suffix}`;
		const prefix = `# Large file ${suffix}\n\nIdentity: ${fileId}\n\n${marker}\n\n`;
		const prefixBytes = Buffer.byteLength(prefix, "utf8");
		if (prefixBytes > bytesPerFile) throw new Error(`large review prefix ${suffix} exceeds its byte budget`);
		const markdown = prefix + "x".repeat(bytesPerFile - prefixBytes);
		return { fileId, title, markdown, bytes: Buffer.byteLength(markdown, "utf8"), marker };
	});
}

export function largeReviewCanonicalHash(files = largeReviewFiles()): string {
	const canonical = JSON.stringify(files.map(({ fileId, title, markdown }) => ({ fileId, title, markdown })));
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function assertLargeReviewFixture(files = largeReviewFiles()): void {
	if (files.length !== LARGE_REVIEW_FILE_COUNT) throw new Error(`expected ${LARGE_REVIEW_FILE_COUNT} files, got ${files.length}`);
	const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.markdown, "utf8"), 0);
	if (total !== LARGE_REVIEW_TOTAL_BYTES) throw new Error(`expected ${LARGE_REVIEW_TOTAL_BYTES} UTF-8 bytes, got ${total}`);
	if (total <= 32 * 1024) throw new Error("large review fixture must exceed the generic 32 KiB truncation threshold");
	if (new Set(files.map((file) => file.fileId)).size !== files.length) throw new Error("large review fixture file identities must be unique");
	if (files[8]?.title !== files[9]?.title || files[8]?.fileId === files[9]?.fileId) {
		throw new Error("large review fixture must include duplicate display titles with distinct identities");
	}
}

export function reviewToolCard(page: Page) {
	return page.locator('[data-tool-name="review_open"]').filter({ hasText: LARGE_REVIEW_TITLE }).last();
}

export function largeReviewPrimaryTab(page: Page) {
	return page.locator(`.goal-tab-pill[data-panel-tab-kind="review"][data-panel-tab-id="${LARGE_REVIEW_TAB_ID}"]`);
}

export function largeReviewPane(page: Page) {
	return page.locator(`.side-panel-pane[data-panel-tab-id="${LARGE_REVIEW_TAB_ID}"] review-pane, .side-panel-workspace review-pane`).last();
}

export function selectedReviewModel(page: Page): Promise<any> {
	return largeReviewPane(page).evaluate((pane: any) => ({
		reviewId: pane.review?.reviewId,
		title: pane.review?.title,
		activeFileId: pane.review?.activeFileId,
		files: pane.review?.files?.map((file: any) => ({ fileId: file.fileId, title: file.title })),
		source: pane.review?.source,
	}));
}

export function workspaceReviewSource(page: Page, sessionId: string): Promise<any> {
	return page.evaluate(({ owner, tabId }) => {
		const appState = (window as any).bobbitState ?? (window as any).__bobbitState;
		const tab = appState?.sidePanelWorkspaceBySession?.[owner]?.tabs?.find((candidate: any) => candidate.id === tabId);
		return tab ? { id: tab.id, source: tab.source, state: tab.state } : null;
	}, { owner: sessionId, tabId: LARGE_REVIEW_TAB_ID });
}

function findLargeReviewReceipt(gateway: any, sessionId: string): ReviewReceiptV2Fixture | undefined {
	const agent = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent;
	if (!Array.isArray(agent?.conversationMessages)) return undefined;
	const calls = agent.conversationMessages.flatMap((message: any) => Array.isArray(message?.content) ? message.content : [])
		.filter((block: any) => block?.type === "toolCall" && block?.name === "review_open" && block?.arguments?.title === LARGE_REVIEW_TITLE);
	const call = calls.at(-1);
	if (!call?.id) return undefined;
	const result = agent.conversationMessages.findLast((message: any) => message?.role === "toolResult" && message?.toolCallId === call.id);
	const text = result?.content?.find((block: any) => block?.type === "text")?.text;
	if (typeof text !== "string") return undefined;
	return JSON.parse(text) as ReviewReceiptV2Fixture;
}

export async function waitForLargeReviewReceipt(gateway: any, sessionId: string, timeoutMs = 30_000): Promise<ReviewReceiptV2Fixture> {
	const deadline = Date.now() + timeoutMs;
	do {
		const receipt = findLargeReviewReceipt(gateway, sessionId);
		if (receipt) return receipt;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(`mock trigger ${LARGE_REVIEW_TRIGGER} did not produce its correlated review_open receipt within ${timeoutMs}ms`);
}

export function assertBoundedReceipt(receipt: ReviewReceiptV2Fixture, files = largeReviewFiles()): void {
	if (receipt.action !== "review_open" || receipt.version !== 2) throw new Error("large review must emit the approved v2 review_open receipt");
	if (receipt.reviewId !== LARGE_REVIEW_ID) throw new Error(`expected stable reviewId ${LARGE_REVIEW_ID}, got ${receipt.reviewId}`);
	if (!receipt.toolCallId || !receipt.payloadId || !receipt.hash) throw new Error("v2 receipt must bind toolCallId, payloadId, and hash");
	if (receipt.totalBytes !== LARGE_REVIEW_TOTAL_BYTES) throw new Error(`receipt totalBytes mismatch: ${receipt.totalBytes}`);
	if (receipt.activeFileId !== files[0]?.fileId) throw new Error("receipt must retain the fixture active file identity");
	if (receipt.replace !== true) throw new Error("fixture receipt must retain replacement semantics");
	if (Buffer.byteLength(JSON.stringify(receipt), "utf8") >= 32 * 1024) throw new Error("v2 receipt must remain below the generic truncation threshold");
	if (receipt.files.length !== files.length) throw new Error("receipt file count mismatch");
	for (let index = 0; index < files.length; index++) {
		const expected = files[index]!;
		const actual = receipt.files[index]!;
		if (actual.fileId !== expected.fileId || actual.title !== expected.title) throw new Error(`receipt identity/order mismatch at file ${index + 1}`);
		if ((actual.bytes ?? actual.markdownBytes) !== expected.bytes) throw new Error(`receipt byte metadata mismatch at file ${index + 1}`);
	}
	const serialized = JSON.stringify(receipt);
	for (const file of files) {
		if (serialized.includes(file.marker) || serialized.includes(file.markdown)) throw new Error("v2 receipt must not contain canonical Markdown");
	}
	const outcome = receipt.automaticOpen ?? receipt.openOutcome ?? receipt.open;
	if (!outcome || (typeof outcome.status !== "string" && typeof outcome.ok !== "boolean")) {
		throw new Error("v2 receipt must contain a structured automatic-open outcome");
	}
}

function isReviewOpenMutation(route: Route): boolean {
	const request = route.request();
	if (request.method() !== "POST") return false;
	const pathname = new URL(request.url()).pathname.toLowerCase();
	return (pathname.includes("review") && (pathname.includes("payload") || pathname.endsWith("/open")))
		|| pathname.includes("side-panel-workspace");
}

/**
 * Injects one safe retryable server failure into the authoritative manual-open
 * mutation. Keeping route matching here isolates the only endpoint-shape
 * assumption from the journey while the final integration route settles.
 */
export async function failNextReviewOpen(page: Page): Promise<{ attempts: () => number; remove: () => Promise<void> }> {
	let attempts = 0;
	const handler = async (route: Route) => {
		if (!isReviewOpenMutation(route) || attempts > 0) return route.fallback();
		attempts += 1;
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({
				code: "REVIEW_PERSISTENCE_FAILED",
				retryable: true,
				message: "C:\\private\\review.md bearer-secret stack trace must never render",
			}),
		});
	};
	await page.route("**/api/**", handler);
	return {
		attempts: () => attempts,
		remove: () => page.unroute("**/api/**", handler),
	};
}

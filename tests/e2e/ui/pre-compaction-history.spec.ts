/**
 * Browser E2E: pre-compaction history expand affordance.
 *
 * Sidecar plus a hand-crafted `.jsonl` whose entries pre-date the
 * `firstKeptEntryId` boundary. Asserts the "Show N messages before
 * compaction" affordance appears, expanding it reveals dimmed read-only
 * rows, and the affordance still works after a page reload.
 *
 * See docs/design/persist-compaction-history.md \u00a76.3.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, waitForSessionStatus, readE2EToken } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import fs from "node:fs";
import path from "node:path";

function makeJsonl(entries: Array<{
	id: string;
	type?: "message" | "compaction";
	role?: string;
	content?: any;
	firstKeptEntryId?: string;
}>): string {
	const ts = new Date().toISOString();
	return entries.map((e) => {
		if (e.type === "compaction") {
			return JSON.stringify({
				type: "compaction",
				id: e.id,
				parentId: null,
				timestamp: ts,
				summary: "",
				firstKeptEntryId: e.firstKeptEntryId ?? "",
				tokensBefore: 1000,
			});
		}
		return JSON.stringify({
			type: "message",
			id: e.id,
			parentId: null,
			timestamp: ts,
			ts,
			message: { role: e.role ?? "user", content: e.content ?? "" },
		});
	}).join("\n") + "\n";
}

async function seedSidecarAndJsonl(opts: {
	bobbitDir: string;
	sessionId: string;
	agentSessionFile: string;
	compactionId: string;
	preCount: number;
}): Promise<void> {
	// Build entries: preCount orphans, then kept-1, then a compaction
	// marker (for legacy fallback safety), then kept-tail entries.
	const entries: Array<any> = [];
	for (let i = 0; i < opts.preCount; i++) {
		entries.push({
			id: `pre-${i}`,
			role: i % 2 === 0 ? "user" : "assistant",
			content: `pre-msg-${i}`,
		});
	}
	entries.push({ id: "kept-1", role: "user", content: "kept after compaction" });
	const jsonl = makeJsonl(entries);
	fs.mkdirSync(path.dirname(opts.agentSessionFile), { recursive: true });
	fs.writeFileSync(opts.agentSessionFile, jsonl);

	const sidecarDir = path.join(opts.bobbitDir, "state", "compaction-sidecar");
	fs.mkdirSync(sidecarDir, { recursive: true });
	const safe = opts.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
	const sidecarFile = path.join(sidecarDir, `${safe}.jsonl`);
	const now = new Date().toISOString();
	fs.appendFileSync(sidecarFile, JSON.stringify({
		schemaVersion: 1,
		id: opts.compactionId,
		trigger: "manual",
		tokensBefore: 50_000,
		tokensAfter: null,
		durationMs: 1000,
		startedAt: now,
		endedAt: now,
		success: true,
		firstKeptEntryId: "kept-1",
	}) + "\n", "utf-8");
}

test.describe("Pre-compaction history affordance", () => {
	test("expand shows dimmed read-only rows; affordance survives reload", async ({ page, gateway }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		const compactionId = "c_precomp_happy";
		// Sidecar can be seeded eagerly (host-side path, not touched by
		// the agent). The card on the snapshot is driven by this.
		const sidecarDir = path.join(gateway.bobbitDir, "state", "compaction-sidecar");
		fs.mkdirSync(sidecarDir, { recursive: true });
		const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
		const now = new Date().toISOString();
		fs.writeFileSync(path.join(sidecarDir, `${safe}.jsonl`), JSON.stringify({
			schemaVersion: 1,
			id: compactionId,
			trigger: "manual",
			tokensBefore: 50_000,
			tokensAfter: null,
			durationMs: 1000,
			startedAt: now,
			endedAt: now,
			success: true,
			firstKeptEntryId: "kept-1",
		}) + "\n", "utf-8");

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Card from the sidecar splice should appear regardless of jsonl content.
		const card = page.locator("[data-testid='compaction-summary-card']");
		await expect(card).toHaveCount(1, { timeout: 15_000 });

		// Now override agentSessionFile to a dedicated path we control, then
		// seed the jsonl. The mock-agent only writes during get_state; once
		// the session is settled we won't see another rewrite, so our seed
		// survives. (If a future get_state fires, the mock would write at
		// the NEW path we've just set — which means it would overwrite our
		// seed, but that path was already written empty by the mock at start.
		// We re-seed after the override.)
		let ps: any;
		await expect.poll(
			() => {
				ps = (gateway.sessionManager as any).getPersistedSession(sessionId);
				return !!ps?.agentSessionFile;
			},
			{ timeout: 15_000, intervals: [250] },
		).toBe(true);
		const dedicatedJsonl = path.join(
			gateway.bobbitDir,
			"state",
			`pre-compaction-test-${sessionId}.jsonl`,
		);
		const store = (gateway.sessionManager as any).getSessionStore(ps.projectId);
		store.update(sessionId, { agentSessionFile: dedicatedJsonl });
		await seedSidecarAndJsonl({
			bobbitDir: gateway.bobbitDir,
			sessionId,
			agentSessionFile: dedicatedJsonl,
			compactionId,
			preCount: 3,
		});

		// Sanity check: the REST endpoint must see our seeded jsonl.
		const probeResp = await page.evaluate(async ({ url, token }) => {
			const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
			return { status: r.status, body: await r.text() };
		}, {
			url: `${gateway.baseURL}/api/sessions/${sessionId}/transcript/before-compaction?compactionId=${compactionId}&limit=1`,
			token: readE2EToken(),
		});
		expect(probeResp.status, `probe body: ${probeResp.body}`).toBe(200);
		const probeJson = JSON.parse(probeResp.body);
		expect(probeJson.total).toBe(3);

		// The widget mounted before our jsonl seed — ask it to refresh.
		await page.evaluate(() => {
			const el = document.querySelector("bobbit-pre-compaction-history") as any;
			el?.refreshCount?.();
		});

		const widget = page.locator("[data-testid='pre-compaction-history']");
		await expect(widget).toHaveCount(1, { timeout: 15_000 });
		// Count fetch fires lazily on viewport hit \u2014 scroll into view to be
		// sure, then wait for the data-state to flip to "collapsed".
		await widget.scrollIntoViewIfNeeded();
		await expect(widget).toHaveAttribute("data-state", "collapsed", { timeout: 15_000 });

		const toggle = page.locator("[data-testid='pre-compaction-toggle']");
		await expect(toggle).toContainText(/Show 3 messages before compaction/);

		await toggle.click();
		await expect(widget).toHaveAttribute("data-state", "expanded", { timeout: 15_000 });
		const rows = page.locator("[data-testid='pre-compaction-row']");
		await expect(rows).toHaveCount(3, { timeout: 15_000 });

		// Dimmed + read-only: container has pointer-events:none and opacity ~0.65.
		const container = page.locator("[data-testid='pre-compaction-rows']");
		await expect(container).toHaveCSS("pointer-events", "none");
		const opacity = await container.evaluate((el) => getComputedStyle(el).opacity);
		expect(parseFloat(opacity)).toBeLessThan(1);

		// And the rows must contain the seeded text.
		await expect(rows.first()).toContainText("pre-msg-0");
		await expect(rows.last()).toContainText("pre-msg-2");

		// Reload \u2014 affordance is collapsed by default but works again.
		// Re-apply the agentSessionFile override after reload; the post-reload
		// get_state would otherwise reset it back to the mock's own path.
		await page.reload();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		store.update(sessionId, { agentSessionFile: dedicatedJsonl });
		await seedSidecarAndJsonl({
			bobbitDir: gateway.bobbitDir,
			sessionId,
			agentSessionFile: dedicatedJsonl,
			compactionId,
			preCount: 3,
		});
		await expect(card).toHaveCount(1, { timeout: 20_000 });
		const widget2 = page.locator("[data-testid='pre-compaction-history']");
		await widget2.scrollIntoViewIfNeeded();
		await page.evaluate(() => {
			const el = document.querySelector("bobbit-pre-compaction-history") as any;
			el?.refreshCount?.();
		});
		await expect(widget2).toHaveAttribute("data-state", "collapsed", { timeout: 20_000 });
		await page.locator("[data-testid='pre-compaction-toggle']").click();
		await expect(widget2).toHaveAttribute("data-state", "expanded", { timeout: 15_000 });
		await expect(page.locator("[data-testid='pre-compaction-row']"))
			.toHaveCount(3, { timeout: 15_000 });
	});
});

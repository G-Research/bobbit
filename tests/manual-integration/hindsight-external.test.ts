/**
 * Manual-integration — Hindsight external mode against a REAL local Hindsight.
 *
 * This test talks directly to a running Hindsight instance over HTTP (no Bobbit
 * gateway, no extension host) and exercises the exact request/response contract
 * the pack's `HindsightClient` implements (docs/design/hindsight-pack-external.md
 * §3, verified against the upstream `openapi.json`). It is the ground-truth check
 * that `ensureBank → retain → recall` round-trips against the real engine,
 * tolerating Hindsight's asynchronous fact-extraction pipeline.
 *
 * It is deliberately self-contained (raw `fetch`, no import of the unbuilt pack
 * client) so it can run the moment a Hindsight is reachable, independent of the
 * pack build. The pack's own unit suite (`tests/hindsight-client.test.ts`) pins
 * the client wrapper against the in-process stub.
 *
 * Environment:
 *   HINDSIGHT_URL  — base URL of the running Hindsight (default http://localhost:8888)
 *   HINDSIGHT_NS   — namespace path segment (default "default")
 *   HINDSIGHT_BANK — dedicated bank id (default "bobbit-it") so this never
 *                    pollutes the shared production `bobbit` bank.
 *   HINDSIGHT_API_KEY — optional bearer token (sent only when set).
 *
 * Skips CLEANLY (test marked skipped, never failed) when the health probe shows
 * Hindsight is unreachable — so the manual suite stays green on machines without
 * a local Hindsight.
 *
 *   npm run build && npx playwright test --config playwright-manual.config.ts \
 *     --grep "hindsight-external"
 */
import { test, expect } from "@playwright/test";

const BASE_URL = (process.env.HINDSIGHT_URL ?? "http://localhost:8888").replace(/\/+$/, "");
const NAMESPACE = process.env.HINDSIGHT_NS ?? "default";
const BANK = process.env.HINDSIGHT_BANK ?? "bobbit-it";
const API_KEY = process.env.HINDSIGHT_API_KEY;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	const h: Record<string, string> = { ...extra };
	// API key header is sent ONLY when configured — mirrors the client contract.
	if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
	return h;
}

const seg = (s: string) => encodeURIComponent(s);
const bankBase = `${BASE_URL}/v1/${seg(NAMESPACE)}/banks/${seg(BANK)}`;

/** Bounded fetch with an AbortController so a hung Hindsight cannot hang the test. */
async function fetchJson(
	url: string,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; ok: boolean; body: any }> {
	const { timeoutMs = 10_000, ...rest } = init;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...rest, signal: ctrl.signal });
		let body: any = null;
		const text = await res.text();
		if (text) {
			try { body = JSON.parse(text); } catch { body = text; }
		}
		return { status: res.status, ok: res.ok, body };
	} finally {
		clearTimeout(timer);
	}
}

/** Health probe used to decide skip-vs-run. Never throws. */
async function hindsightReachable(): Promise<boolean> {
	try {
		const res = await fetchJson(`${BASE_URL}/health`, { method: "GET", headers: authHeaders(), timeoutMs: 3_000 });
		return res.ok;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.describe.configure({ mode: "serial" });

test.describe("hindsight-external (real local Hindsight)", () => {
	test("ensureBank → retain → recall round-trips, tolerating async extraction", async () => {
		test.setTimeout(120_000);

		if (!(await hindsightReachable())) {
			test.skip(true, `Hindsight not reachable at ${BASE_URL} (set HINDSIGHT_URL to run)`);
			return;
		}

		// Unique marker so recall can unambiguously find THIS run's memory and the
		// assertion never collides with leftover facts from a previous run.
		const marker = `bobbit-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const content = `Bobbit integration fact: the secret project codename is ${marker}.`;
		const tags = ["project:bobbit-it", "kind:turn", `session:${marker}`];

		// 1. ensureBank — PUT …/banks/{bank} with a minimal create-or-update body.
		const ensure = await fetchJson(bankBase, {
			method: "PUT",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({}),
		});
		expect(ensure.ok, `ensureBank failed: ${ensure.status} ${JSON.stringify(ensure.body)}`).toBeTruthy();

		// 2. retain — POST …/memories with item-level tags. Use sync extraction
		//    (async:false) so the fact is committed before we begin polling; recall
		//    can still lag while indexing settles, hence the poll loop below.
		const retain = await fetchJson(`${bankBase}/memories`, {
			method: "POST",
			headers: authHeaders({ "Content-Type": "application/json" }),
			body: JSON.stringify({ items: [{ content, tags }], async: false }),
			timeoutMs: 60_000,
		});
		expect(retain.ok, `retain failed: ${retain.status} ${JSON.stringify(retain.body)}`).toBeTruthy();
		expect(retain.body?.bank_id).toBe(BANK);

		// 3. recall — POST …/memories/recall, polling up to ~30s for the marker to
		//    surface (Hindsight's extraction/indexing is eventually-consistent).
		const deadline = Date.now() + 30_000;
		let found = false;
		let lastResults: any[] = [];
		while (Date.now() < deadline && !found) {
			const recall = await fetchJson(`${bankBase}/memories/recall`, {
				method: "POST",
				headers: authHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ query: `secret project codename ${marker}`, max_tokens: 1024 }),
				timeoutMs: 15_000,
			});
			if (recall.ok && Array.isArray(recall.body?.results)) {
				lastResults = recall.body.results;
				found = lastResults.some((r: any) => typeof r?.text === "string" && r.text.includes(marker));
			}
			if (!found) await sleep(1_500);
		}

		expect(
			found,
			`recall did not surface marker ${marker} within 30s; last results: ${JSON.stringify(lastResults).slice(0, 800)}`,
		).toBeTruthy();

		// 4. Best-effort cleanup so the dedicated IT bank does not accumulate facts
		//    across runs. Failure here must not fail the test.
		await fetchJson(`${bankBase}/memories`, {
			method: "DELETE",
			headers: authHeaders(),
			timeoutMs: 15_000,
		}).catch(() => { /* best-effort */ });
	});
});

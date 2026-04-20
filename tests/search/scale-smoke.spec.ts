/**
 * @slow Scale smoke test: ~40K synthetic Indexables, open-time + query
 * latency within sane bounds. Validates FlexSearch scales for Bobbit.
 *
 * Opt-in only. Set `RUN_SCALE_SMOKE=1` to run.
 *
 * Design reference: docs/design/portable-search.md §5.5, §17.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlexSearchStore, type FlexDoc } from "../../src/server/search/flex-store.ts";

const SHOULD_RUN = process.env.RUN_SCALE_SMOKE === "1";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "scale-smoke-"));
}

function synthText(i: number): string {
	const topics = ["error", "session", "goal", "story", "refactor", "token", "query", "plan"];
	const t = topics[i % topics.length];
	const rare = `rare-${i.toString(36)}`;
	return `${t} ${rare} line ${i} message body with some padding text for realism`;
}

function synthDoc(i: number): FlexDoc {
	return {
		id: `e${i}`,
		source_id: "messages",
		project_id: "p1",
		entity_type: "message",
		parent_id: null,
		archived: false,
		archived_tag: "false",
		timestamp: 1_700_000_000_000 + i,
		content_hash: `h${i}`,
		weight: 1.0,
		role: "user",
		title: null,
		text: synthText(i),
		identifier_text: "",
		goal_id: null,
		session_id: `s${i % 100}`,
		session_title: null,
		file_path: null,
		start_line: null,
		end_line: null,
	};
}

test.describe("@slow scale smoke", () => {
	test.skip(!SHOULD_RUN, "Set RUN_SCALE_SMOKE=1 to run the scale test");
	test.setTimeout(10 * 60_000);

	test("40K synthetic rows; reopen in < 10s; p95 query < 200ms", async () => {
		const dir = path.join(tmpDir(), "search.flex");
		const store = await FlexSearchStore.open({ dataDir: dir });

		const N = 40_000;
		const BATCH = 2000;
		const t0 = Date.now();
		for (let i = 0; i < N; i += BATCH) {
			const batch: FlexDoc[] = [];
			for (let j = 0; j < BATCH && i + j < N; j++) batch.push(synthDoc(i + j));
			await store.upsert(batch);
		}
		// eslint-disable-next-line no-console
		console.log(`[scale-smoke] upsert ${N}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		await store.close();

		// Reopen.
		const tOpen = Date.now();
		const reopened = await FlexSearchStore.open({ dataDir: dir });
		const openMs = Date.now() - tOpen;
		// eslint-disable-next-line no-console
		console.log(`[scale-smoke] reopen: ${openMs}ms`);
		expect(openMs).toBeLessThan(10_000);
		expect(reopened.count()).toBeGreaterThanOrEqual(N);

		const latencies: number[] = [];
		const topics = ["error", "session", "goal", "story", "refactor", "token", "query", "plan"];
		for (let i = 0; i < 50; i++) {
			const q = topics[i % topics.length] + " " + (i % 2 === 0 ? "line" : "rare");
			const start = Date.now();
			await reopened.search({ q, limit: 20 });
			latencies.push(Date.now() - start);
		}
		latencies.sort((a, b) => a - b);
		const p95 = latencies[Math.floor(latencies.length * 0.95)];
		// eslint-disable-next-line no-console
		console.log(
			`[scale-smoke] latencies ms: min=${latencies[0]} p50=${latencies[25]} p95=${p95}`,
		);
		expect(p95).toBeLessThan(200);

		await reopened.close();
	});
});

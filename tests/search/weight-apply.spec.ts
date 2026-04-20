/**
 * Unit test for the post-rank weight multiplier applied by
 * `FlexSearchStore.search`. Per design §9: at equal base relevance, a
 * higher-weighted row must outrank a lower-weighted one.
 *
 * Drops a synthetic pair of rows with identical text so BM25 cannot
 * break the tie; all ordering must come from the weight multiplier.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlexSearchStore, type FlexDoc } from "../../src/server/search/flex-store.ts";

test.setTimeout(30_000);

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "weight-apply-test-"));
}

function row(id: string, weight: number, role: string | null = "user"): FlexDoc {
	return {
		id,
		source_id: "messages",
		project_id: "p1",
		entity_type: "message",
		parent_id: null,
		archived: false,
		archived_tag: "false",
		timestamp: 1_700_000_000_000,
		content_hash: `h-${id}-${weight}`,
		weight,
		role,
		title: `Title ${id}`,
		text: "alpha alpha alpha",
		identifier_text: "",
		goal_id: null,
		session_id: "s1",
		session_title: "Session 1",
		file_path: null,
		start_line: null,
		end_line: null,
	};
}

test("weight 2.0 outranks weight 1.0 at identical text", async () => {
	const dir = path.join(tmpDir(), "search.flex");
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([row("low", 1.0), row("high", 2.0)]);
		const res = await store.search({ q: "alpha", limit: 10 });
		expect(res.results.length).toBe(2);
		expect(res.results[0].id).toBe("high");
		expect(res.results[1].id).toBe("low");
		expect(res.results[0].score).toBeGreaterThan(res.results[1].score);
		const ratio = res.results[0].score / res.results[1].score;
		expect(ratio).toBeCloseTo(2.0, 1);
	} finally {
		await store.close();
	}
});

test("user-role (weight 2.0) outranks assistant-role (weight 1.0)", async () => {
	const dir = path.join(tmpDir(), "search.flex");
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			row("asst", 1.0, "assistant"),
			row("user", 2.0, "user"),
		]);
		const res = await store.search({ q: "alpha", limit: 10 });
		expect(res.results.length).toBe(2);
		expect(res.results[0].id).toBe("user");
		expect(res.results[1].id).toBe("asst");
	} finally {
		await store.close();
	}
});

test("weight ordering persists across three distinct weights", async () => {
	const dir = path.join(tmpDir(), "search.flex");
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([row("w05", 0.5), row("w10", 1.0), row("w25", 2.5)]);
		const res = await store.search({ q: "alpha", limit: 10 });
		expect(res.results.map((r) => r.id)).toEqual(["w25", "w10", "w05"]);
	} finally {
		await store.close();
	}
});

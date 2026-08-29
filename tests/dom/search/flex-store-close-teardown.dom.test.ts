import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlexSearchStore, type FlexDoc } from "../../../src/server/search/flex-store.ts";

function tmp(prefix = "flex-mirror-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function doc(id: string, text: string): FlexDoc {
	return {
		id, source_id: "messages", project_id: "p1", entity_type: "message", parent_id: null,
		archived: false, archived_tag: "false", timestamp: 1_700_000_000_000,
		content_hash: `${id}:hash`, weight: 1, role: "assistant", title: null, text,
		identifier_text: "", goal_id: null, session_id: "s1", session_title: "Session",
		file_path: null, start_line: null, end_line: null,
	};
}

async function dispose(store: FlexSearchStore, dir: string): Promise<void> {
	await store.close();
	fs.rmSync(dir, { recursive: true, force: true });
}

test("graceful close persists only the durable mirror, never a FlexSearch export", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([doc("one", "durable mirror token")]);
		await store.close();

		const indexDir = path.join(dir, "index");
		const snapshot = JSON.parse(fs.readFileSync(path.join(indexDir, "__docs__.json"), "utf8")) as {
			version: number;
			throughSequence: number;
			docs: FlexDoc[];
		};
		expect(snapshot).toMatchObject({ version: 1, throughSequence: 1 });
		expect(snapshot.docs.map((row) => row.id)).toEqual(["one"]);
		expect(fs.readFileSync(path.join(indexDir, "__docs__.journal"), "utf8")).toBe("");
		expect(fs.readdirSync(indexDir)).not.toContain("__index__.json");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("reopen recovers a journaled mutation that survives an interrupted compaction", async () => {
	const dir = tmp();
	const indexDir = path.join(dir, "index");
	const first = await FlexSearchStore.open({ dataDir: dir });
	await first.upsert([doc("before", "snapshot token")]);
	await first.close();

	// A process can die after append but before the next compaction. The journal
	// is part of the durable mirror contract and must be replayed on restart.
	const second = doc("after", "journal recovery token");
	fs.appendFileSync(path.join(indexDir, "__docs__.journal"), `${JSON.stringify({ version: 1, sequence: 2, operation: { op: "upsert", doc: second } })}\n`);

	const recovered = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect(recovered.count()).toBe(2);
		expect((await recovered.search({ q: "journal recovery" })).results.map((row) => row.id)).toContain("after");
	} finally {
		await dispose(recovered, dir);
	}
});

test("recovery skips the old journal tail left by a crash after snapshot rename", async () => {
	const dir = tmp();
	const indexDir = path.join(dir, "index");
	fs.mkdirSync(indexDir, { recursive: true });
	const snapshotted = doc("snapshot", "snapshot state token");
	const newer = doc("newer", "newer journal token");
	// This is the precise crash window: the envelope is durable, but the
	// pre-compaction journal has not yet been atomically rewritten.
	fs.writeFileSync(path.join(indexDir, "__docs__.json"), JSON.stringify({
		version: 1,
		throughSequence: 4,
		docs: [snapshotted],
	}));
	fs.writeFileSync(path.join(indexDir, "__docs__.journal"), [
		JSON.stringify({ version: 1, sequence: 3, operation: { op: "delete", ids: ["snapshot"] } }),
		JSON.stringify({ version: 1, sequence: 5, operation: { op: "upsert", doc: newer } }),
	].join("\n") + "\n");

	const recovered = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect(recovered.getById("snapshot")).not.toBeNull();
		expect(recovered.getById("newer")).not.toBeNull();
		// The next write continues after both the snapshot and replayed journal,
		// never reusing a sequence after restart.
		await recovered.upsert([doc("after-restart", "continued sequence token")]);
		await (recovered as any)._flushNow();
		const records = fs.readFileSync(path.join(indexDir, "__docs__.journal"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(records.at(-1)?.sequence).toBe(6);
	} finally {
		await dispose(recovered, dir);
	}
});

test("legacy bare snapshots and bare journal operations remain readable and migrate on compact", async () => {
	const dir = tmp();
	const indexDir = path.join(dir, "index");
	fs.mkdirSync(indexDir, { recursive: true });
	const snapshotted = doc("legacy-snapshot", "legacy snapshot token");
	const journaled = doc("legacy-journal", "legacy journal token");
	fs.writeFileSync(path.join(indexDir, "__docs__.json"), JSON.stringify([snapshotted]));
	fs.writeFileSync(path.join(indexDir, "__docs__.journal"), `${JSON.stringify({ op: "upsert", doc: journaled })}\n`);

	const recovered = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect(recovered.count()).toBe(2);
		await recovered.compact();
		const migrated = JSON.parse(fs.readFileSync(path.join(indexDir, "__docs__.json"), "utf8")) as { version: number; throughSequence: number; docs: FlexDoc[] };
		expect(migrated).toMatchObject({ version: 1, throughSequence: 0 });
		expect(migrated.docs.map((row) => row.id).sort()).toEqual(["legacy-journal", "legacy-snapshot"]);
		expect(fs.readFileSync(path.join(indexDir, "__docs__.journal"), "utf8")).toBe("");
	} finally {
		await dispose(recovered, dir);
	}
});

test("startup removes stale derived-index and interrupted tmp artifacts without losing mirror rows", async () => {
	const dir = tmp();
	const seed = await FlexSearchStore.open({ dataDir: dir });
	await seed.upsert([doc("keep", "legacy cleanup token")]);
	await seed.close();
	const indexDir = path.join(dir, "index");
	for (const name of ["__index__.json", "1.reg.json", "1.tag.json", "__docs__.json.tmp"]) {
		fs.writeFileSync(path.join(indexDir, name), "stale cache");
	}

	const reopened = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect((await reopened.search({ q: "legacy cleanup" })).results.map((row) => row.id)).toContain("keep");
		expect(fs.readdirSync(indexDir)).toEqual(expect.arrayContaining(["__docs__.json", "__docs__.journal"]));
		for (const name of ["__index__.json", "1.reg.json", "1.tag.json", "__docs__.json.tmp"]) {
			expect(fs.existsSync(path.join(indexDir, name))).toBe(false);
		}
	} finally {
		await dispose(reopened, dir);
	}
});

test("close completes persistence before a caller removes its state directory", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	await store.upsert([doc("one", "close race token")]);
	await store.close();
	fs.rmSync(dir, { recursive: true, force: true });
	await new Promise((resolve) => setTimeout(resolve, 25));
	expect(fs.existsSync(dir)).toBe(false);
});

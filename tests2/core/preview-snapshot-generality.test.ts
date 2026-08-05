import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
	PREVIEW_SNAPSHOT_MARKER_V3,
	buildPreviewSnapshotV3Block,
} from "../../defaults/tools/html/snapshot.ts";
import {
	previewEntryFromStoredValue,
	previewRouteFromStoredValue,
} from "../../src/app/gateway-fetch.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SID = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);
const ARTIFACT_ID = "ZolfVVBQ";
const COMPACT_URL = `/preview/${SID}/`;

type FilenameCase = {
	name: string;
	entry: string;
};

// Raw disk filenames from the real writer/reader probe. The writer receives
// the encoded mount URL; the marker must retain a raw, standalone entry.
const filenameCases: FilenameCase[] = [
	{ name: "plain", entry: "bar.html" },
	{ name: "index", entry: "index.html" },
	{ name: "space", entry: "my report.html" },
	{ name: "parens", entry: "chart (final).html" },
	{ name: "ampersand", entry: "a&b.html" },
	{ name: "question", entry: "q?x.html" },
	{ name: "hash", entry: "hash#tag.html" },
	{ name: "percent-bare", entry: "100%.html" },
	{ name: "percent-escape", entry: "%41.html" },
	{ name: "percent-encoded-literal", entry: "50%25.html" },
	{ name: "accented", entry: "résumé.html" },
	{ name: "cjk", entry: "日本語.html" },
	{ name: "emoji", entry: "emoji-🎉.html" },
	{ name: "uppercase-ext", entry: "UPPER.HTML" },
	{ name: "dots", entry: "dot.in.name.html" },
	{ name: "long-name", entry: `${"n".repeat(200)}.html` },
];

function payloadOf(block: string): Record<string, unknown> {
	return JSON.parse(block.slice(PREVIEW_SNAPSHOT_MARKER_V3.length).trim()) as Record<string, unknown>;
}

function expectWriterFailure(
	entry: string,
	expectedCode: "PREVIEW_SNAPSHOT_CAP" | "PREVIEW_SNAPSHOT_ENTRY",
	artifactId = ARTIFACT_ID,
): Error {
	try {
		buildPreviewSnapshotV3Block(
			`/preview/${SID}/${encodeURIComponent(entry)}`,
			`${SID}/${entry}`,
			HASH,
			{ artifactId, entry },
		);
	} catch (error) {
		assert.ok(error instanceof Error, `${expectedCode}: writer must throw an Error for ${JSON.stringify(entry)}`);
		assert.match(error.message, new RegExp(expectedCode), `${expectedCode}: writer must identify why ${JSON.stringify(entry)} was rejected`);
		assert.ok(error.message.includes(JSON.stringify(entry)), `${expectedCode}: writer error must name ${JSON.stringify(entry)}`);
		return error;
	}
	assert.fail(`${expectedCode}: writer accepted ${JSON.stringify(entry)} instead of failing loudly`);
}

describe("preview snapshot filename generality", () => {
	it("ships an adjacent, byte-identical codec for the copied-defaults snapshot layout", () => {
		const sharedCodec = readFileSync(resolve(REPO_ROOT, "src/shared/preview-entry-codec.ts"), "utf8");
		const shippedCodec = readFileSync(resolve(REPO_ROOT, "defaults/tools/html/preview-entry-codec.ts"), "utf8");
		const snapshot = readFileSync(resolve(REPO_ROOT, "defaults/tools/html/snapshot.ts"), "utf8");

		assert.equal(
			shippedCodec,
			sharedCodec,
			"the defaults tree is copied verbatim to dist/server/defaults, so its codec mirror must stay in lockstep with app/server consumers",
		);
		assert.match(
			snapshot,
			/from "\.\/preview-entry-codec\.js";/,
			"the copied snapshot must resolve its codec from the adjacent shipped defaults directory",
		);
	});

	it.each(filenameCases)("stores a standalone canonical replay marker for $name filenames", ({ entry }) => {
		const block = buildPreviewSnapshotV3Block(
			`/preview/${SID}/${encodeURIComponent(entry)}`,
			`${SID}/${entry}`,
			HASH,
			{ artifactId: ARTIFACT_ID, entry },
		);
		const payload = payloadOf(block);

		assert.ok(
			Buffer.byteLength(block, "utf8") <= 250,
			`PREVIEW_SNAPSHOT_CAP: ${entry} emitted ${Buffer.byteLength(block, "utf8")} bytes`,
		);
		assert.equal(payload.url, COMPACT_URL, `PREVIEW_SNAPSHOT_COMPACTION: ${entry} must use the compact directory URL`);
		assert.equal(payload.contentHash, HASH, `PREVIEW_SNAPSHOT_METADATA: ${entry} must retain canonical contentHash`);
		assert.equal(payload.artifactId, ARTIFACT_ID, `PREVIEW_SNAPSHOT_METADATA: ${entry} must retain canonical artifactId`);
		assert.equal(typeof payload.entry, "string", `PREVIEW_SNAPSHOT_ENTRY: ${entry} must be self-contained in its marker`);

		const storedEntry = previewEntryFromStoredValue(payload.entry);
		assert.equal(storedEntry, entry, `PREVIEW_SNAPSHOT_ENTRY: ${entry} must be accepted unchanged by the reader`);
		assert.equal(
			previewRouteFromStoredValue(payload.url, payload.entry),
			`/preview/${SID}/${encodeURIComponent(entry)}`,
			`PREVIEW_SNAPSHOT_ROUTE: ${entry} must reconstruct its exact raw filename without tool-call parameters`,
		);
	});

	it.each([
		["37-byte ASCII", "quarterly-revenue-breakdown-2024.html"],
		["43-byte ASCII", "quarterly-revenue-breakdown-2024-final.html"],
		["46-byte ASCII", "bobbit-preview-filename-generality-report.html"],
		["long ASCII", "north-america-quarterly-revenue-by-product-line-and-customer-segment-analysis-fiscal-year-2024-final-draft-report.html"],
		["CJK", "日本語のレポート-2024年第4四半期.html"],
	] as const)("keeps canonical replay identity for realistic $0 names via stored or trusted entry", (_name, entry) => {
		const block = buildPreviewSnapshotV3Block(
			`/preview/${SID}/${encodeURIComponent(entry)}`,
			`${SID}/${entry}`,
			HASH,
			{ artifactId: ARTIFACT_ID, entry },
		);
		const payload = payloadOf(block);

		assert.ok(Buffer.byteLength(block, "utf8") <= 250, `${entry} must respect the marker cap`);
		assert.equal(payload.url, COMPACT_URL);
		assert.equal(payload.contentHash, HASH, `${entry} must retain canonical contentHash`);
		assert.equal(payload.artifactId, ARTIFACT_ID, `${entry} must retain canonical artifactId`);
		assert.equal(payload.aid, undefined, `${entry} must not emit artifact aliases`);
		assert.equal(payload.a, undefined, `${entry} must not emit artifact aliases`);

		const replayEntry = payload.entry === undefined ? entry : payload.entry;
		assert.equal(
			previewRouteFromStoredValue(payload.url, replayEntry),
			`/preview/${SID}/${encodeURIComponent(entry)}`,
			`${entry} must reconstruct from its stored entry or trusted preview_open params`,
		);
	});

	it.each([
		["empty", ""],
		["current directory", "."],
		["parent directory", ".."],
		["forward slash", "nested/secret.html"],
		["backslash", "nested\\secret.html"],
		["NUL control", "unsafe\0.html"],
		["unit-separator control", "unsafe\u001f.html"],
	] as const)("rejects unsafe filename at write time: %s", (_name, entry) => {
		expectWriterFailure(entry, "PREVIEW_SNAPSHOT_ENTRY");
	});

	it("fails loudly when maximum canonical replay identity cannot fit", () => {
		const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		const entry = Array.from({ length: 250 }, (_, index) => alphabet[index % alphabet.length]).join("");
		const error = expectWriterFailure(entry, "PREVIEW_SNAPSHOT_CAP", "a".repeat(64));
		assert.match(error.message, /250 UTF-8 byte snapshot cap/, "PREVIEW_SNAPSHOT_CAP: error must explain the bounded marker budget");
	});
});

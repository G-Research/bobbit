import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "vitest";

import {
	PREVIEW_SNAPSHOT_MARKER_V3,
	buildPreviewSnapshotV3Block,
	parseSnapshot,
} from "../../defaults/tools/html/snapshot.ts";
import { previewRouteFromStoredValue } from "../../src/app/gateway-fetch.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const HASH = "a".repeat(64);
const ARTIFACT_ID = "pa_abc123xyz";
const COMPACT_URL = `/preview/${SID}/`;

type FilenameCase = {
	name: string;
	entry: string;
};

// These values are raw disk filenames. They become URL segments only at the
// gateway boundary, where encodeURIComponent is applied exactly once.
const filenameCases: FilenameCase[] = [
	{ name: "plain", entry: "bar.html" },
	{ name: "index", entry: "index.html" },
	{ name: "space", entry: "my report.html" },
	{ name: "ampersand", entry: "a&b.html" },
	{ name: "question", entry: "what?.html" },
	{ name: "hash", entry: "heading#.html" },
	{ name: "parentheses", entry: "report (final).html" },
	{ name: "bare percent", entry: "100%.html" },
	{ name: "percent escape", entry: "%41.html" },
	{ name: "percent-encoded literal", entry: "50%25.html" },
	{ name: "accented", entry: "résumé.html" },
	{ name: "CJK", entry: "日本語.html" },
	{ name: "emoji", entry: "report-😀.html" },
	{ name: "uppercase extension", entry: "REPORT.HTML" },
	{ name: "dots", entry: "report.v1.2.html" },
	{ name: "long", entry: `${"x".repeat(205)}.html` },
];

function payloadOf(block: string): Record<string, unknown> {
	return JSON.parse(block.slice(PREVIEW_SNAPSHOT_MARKER_V3.length).trim()) as Record<string, unknown>;
}

function artifactIdOf(payload: Record<string, unknown>): unknown {
	return payload.artifactId ?? payload.aid ?? payload.a;
}

type PreviewSnapshot = Extract<NonNullable<ReturnType<typeof parseSnapshot>>, { kind: "preview" }>;

function previewSnapshotOf(block: string): PreviewSnapshot {
	const snapshot = parseSnapshot(block);
	if (!snapshot || snapshot.kind !== "preview") {
		throw new Error("PREVIEW_SNAPSHOT_METADATA: writer output must parse as v3 preview");
	}
	return snapshot;
}

function routeForSnapshot(block: string, safeFallbackEntry?: string): string | null {
	const snapshot = previewSnapshotOf(block);
	return previewRouteFromStoredValue(snapshot.url, snapshot.entry ?? safeFallbackEntry);
}

describe("preview snapshot filename generality", () => {
	it.each(filenameCases)("preserves compact replay identity for $name filenames", ({ entry }) => {
		const block = buildPreviewSnapshotV3Block(
			`/preview/${SID}/${entry}`,
			`${SID}/${entry}`,
			HASH,
			{ artifactId: ARTIFACT_ID, entry },
		);
		const payload = payloadOf(block);
		const snapshot = previewSnapshotOf(block);

		assert.ok(
			Buffer.byteLength(block, "utf8") <= 250,
			`PREVIEW_SNAPSHOT_CAP: ${entry} emitted ${Buffer.byteLength(block, "utf8")} bytes`,
		);
		assert.equal(payload.url, COMPACT_URL, `PREVIEW_SNAPSHOT_COMPACTION: ${entry} must use the compact directory URL`);
		assert.equal(snapshot?.contentHash, HASH, `PREVIEW_SNAPSHOT_METADATA: ${entry} lost contentHash`);
		assert.equal(artifactIdOf(payload), ARTIFACT_ID, `PREVIEW_SNAPSHOT_METADATA: ${entry} lost artifactId`);
		assert.equal(snapshot?.artifactId, ARTIFACT_ID, `PREVIEW_SNAPSHOT_METADATA: ${entry} must parse its artifactId alias`);
		if (entry.length <= 200) {
			assert.equal(snapshot?.entry, entry, `PREVIEW_SNAPSHOT_RAW_ENTRY: ${entry} must remain raw in its marker`);
		}
		assert.equal(
			routeForSnapshot(block, entry.length > 200 ? entry : undefined),
			`/preview/${SID}/${encodeURIComponent(entry)}`,
			`PREVIEW_SNAPSHOT_ROUTE: ${entry} must reconstruct its exact raw filename`,
		);
	});

	it("couples an encoded URL to a raw literal-percent entry without decoding it", () => {
		const entry = "100%.html";
		const block = buildPreviewSnapshotV3Block(
			`/preview/${SID}/100%25.html`,
			`${SID}/${entry}`,
			HASH,
			{ artifactId: ARTIFACT_ID, entry },
		);
		const snapshot = previewSnapshotOf(block);

		assert.equal(payloadOf(block).url, COMPACT_URL, "PREVIEW_SNAPSHOT_COMPACTION: encoded URL must compact against raw entry");
		assert.equal(snapshot?.entry, entry, "PREVIEW_SNAPSHOT_PERCENT: marker entry must remain raw");
		const route = routeForSnapshot(block, entry);
		assert.equal(route, `/preview/${SID}/100%25.html`);
		assert.equal(decodeURIComponent(route!.slice(COMPACT_URL.length)), entry);
	});

	it("uses the tool-call entry fallback rather than dropping metadata for a long filename", () => {
		const entry = `${"long-".repeat(42)}.html`;
		const maximumArtifactId = `a${"z".repeat(63)}`;
		const block = buildPreviewSnapshotV3Block(
			`/preview/${SID}/${encodeURIComponent(entry)}`,
			`${SID}/${entry}`,
			HASH,
			{ artifactId: maximumArtifactId, entry },
		);
		const payload = payloadOf(block);
		const snapshot = previewSnapshotOf(block);

		assert.ok(Buffer.byteLength(block, "utf8") <= 250, "PREVIEW_SNAPSHOT_CAP: long-name marker must remain within 250 bytes");
		assert.equal(payload.url, COMPACT_URL, "PREVIEW_SNAPSHOT_COMPACTION: long name must still compact");
		assert.equal(snapshot?.contentHash, HASH, "PREVIEW_SNAPSHOT_METADATA: long name lost contentHash");
		assert.equal(artifactIdOf(payload), maximumArtifactId, "PREVIEW_SNAPSHOT_METADATA: long name lost artifactId");
		assert.equal(snapshot?.artifactId, maximumArtifactId, "PREVIEW_SNAPSHOT_METADATA: long name must parse the shortest artifact alias");
		assert.equal(snapshot?.entry, undefined, "long marker must use trusted preview_open entry indirection");
		assert.equal(routeForSnapshot(block, entry), `/preview/${SID}/${encodeURIComponent(entry)}`);
	});

	it("throws a specific cap error instead of emitting an oversized metadata-losing marker", () => {
		const impossibleEntryPath = "x".repeat(2_000);
		assert.throws(
			() => buildPreviewSnapshotV3Block(
				`/preview/${SID}/unrecoverable.html`,
				impossibleEntryPath,
				HASH,
				{ artifactId: ARTIFACT_ID },
			),
			/PREVIEW_SNAPSHOT_CAP|snapshot.*cap|250/i,
			"PREVIEW_SNAPSHOT_CAP: impossible inputs must fail loudly, never emit a truncated or metadata-losing marker",
		);
	});
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	changesetIdForGithub,
	changesetIdForLocal,
	diffBlockIdForFile,
	hunkIdForBlock,
	lineIdForHunk,
	shortSha,
	stableSlug,
	walkthroughCardId,
} from "../src/shared/pr-walkthrough/ids.ts";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

describe("PR walkthrough stable ids", () => {
	it("uses readable short SHA ids for local changesets", () => {
		assert.equal(changesetIdForLocal(BASE_SHA, HEAD_SHA), "01234567..fedcba98");
	});

	it("uses readable GitHub ids without storage sanitisation", () => {
		assert.equal(changesetIdForGithub("SuuBro", "bobbit", 1842, HEAD_SHA), "github:SuuBro/bobbit#1842:fedcba98");
		assert.equal(changesetIdForGithub("SuuBro", "bobbit", "1842"), "github:SuuBro/bobbit#1842:unknown");
	});

	it("builds stable block, hunk, and line ids", () => {
		const blockId = diffBlockIdForFile("src/ui/foo bar.ts", 2);
		assert.equal(blockId, "block:3:src__ui__foo-bar.ts");
		assert.equal(hunkIdForBlock(blockId, 1), "block:3:src__ui__foo-bar.ts:h1");
		assert.equal(lineIdForHunk(blockId, 1, 9), "block:3:src__ui__foo-bar.ts:h1:l9");
	});

	it("normalises slugs and card ids deterministically", () => {
		assert.equal(shortSha("abc"), "abc");
		assert.equal(stableSlug(" src\\server/a b !.ts "), "src__server__a-b-.ts");
		assert.equal(walkthroughCardId("design", "Model & Adapter", 4), "design-model-adapter-5");
	});
});

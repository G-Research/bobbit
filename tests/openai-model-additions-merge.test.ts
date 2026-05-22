/**
 * Unit test for the merge policy in `writeOpenAIModelAdditions()`
 * (`src/server/agent/openai-model-additions.ts`).
 *
 * Contract:
 *   1. Empty file → all defaults written.
 *   2. Existing entry where field equals the previously-emitted default →
 *      Bobbit-owned, may be overwritten with current default.
 *   3. Existing entry where field differs from the default → user-edited,
 *      preserved across calls.
 *   4. A second call after the test mutates a field locally must NOT clobber
 *      the user edit.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getModels } from "@earendil-works/pi-ai";

let tmp: string;
let previousAgentDir: string | undefined;

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-modeladd-"));
	previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_AGENT_DIR = tmp;
	mkdirSync(tmp, { recursive: true });
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	const f = path.join(tmp, "models.json");
	if (existsSync(f)) rmSync(f);
});

const { writeOpenAIModelAdditions, OPENAI_MODEL_ADDITIONS } = await import("../src/server/agent/openai-model-additions.js");

function readModels(): any {
	const f = path.join(tmp, "models.json");
	if (!existsSync(f)) return null;
	return JSON.parse(readFileSync(f, "utf-8"));
}

function findOptionalEntry(data: any, provider: string, id: string): any | undefined {
	const list = data?.providers?.[provider]?.models;
	if (!Array.isArray(list)) return undefined;
	return list.find((m: any) => m.id === id);
}

function findEntry(data: any, provider: string, id: string): any {
	const e = findOptionalEntry(data, provider, id);
	assert.ok(e, `expected entry ${provider}/${id} in models.json`);
	return e;
}

function hasBuiltIn(provider: string, id: string): boolean {
	return getModels(provider as any).some((m: any) => m.id === id);
}

function customAdditionSample(): (typeof OPENAI_MODEL_ADDITIONS)[number] {
	const sample = OPENAI_MODEL_ADDITIONS.find((m) => !hasBuiltIn(m.provider, m.id));
	assert.ok(sample, "test requires at least one Bobbit-only OpenAI model addition");
	return sample;
}

describe("writeOpenAIModelAdditions merge policy", () => {
	it("empty file → only additions missing from pi-ai built-ins are written", () => {
		writeOpenAIModelAdditions();
		const data = readModels();
		const expected = OPENAI_MODEL_ADDITIONS.filter((m) => !hasBuiltIn(m.provider, m.id));
		if (expected.length > 0) assert.ok(data, "models.json should exist after the call");
		for (const m of expected) {
			const e = findEntry(data, m.provider, m.id);
			assert.equal(e.name, m.name);
			assert.equal(e.api, m.api);
			assert.equal(e.baseUrl, m.baseUrl);
			assert.deepEqual(e.cost, m.cost);
		}
		for (const m of OPENAI_MODEL_ADDITIONS.filter((m) => hasBuiltIn(m.provider, m.id))) {
			assert.equal(findOptionalEntry(data, m.provider, m.id), undefined, `${m.provider}/${m.id} should use pi-ai's built-in metadata`);
		}
	});

	it("user-edited field is preserved on subsequent calls", () => {
		// 1) seed defaults.
		writeOpenAIModelAdditions();
		// 2) user edits a field — change `name` away from the default.
		const data1 = readModels();
		const sample = customAdditionSample();
		const entry = findEntry(data1, sample.provider, sample.id);
		entry.name = "User Custom Name";
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(data1, null, 2));
		// 3) call again — user edit must survive.
		writeOpenAIModelAdditions();
		const data2 = readModels();
		const e2 = findEntry(data2, sample.provider, sample.id);
		assert.equal(e2.name, "User Custom Name", "user-edited name must be preserved");
		// And the OTHER fields (still equal to default) remain in their default state.
		assert.equal(e2.api, sample.api);
		assert.deepEqual(e2.cost, sample.cost);
	});

	it("field that still equals previously-emitted default is treated as Bobbit-owned", () => {
		// Seed an entry whose `name` matches the *current* default. The merge
		// pass should consider it Bobbit-owned (not user-edited) and may
		// overwrite it. Equal-to-default is the simplest case the helper
		// handles. We then mutate the `cost` field to something else and
		// verify mutation survives, while `name` is left undisturbed (because
		// it already matched the default).
		const sample = customAdditionSample();
		const seeded = {
			providers: {
				[sample.provider]: {
					models: [
						{
							id: sample.id,
							name: sample.name, // == default → Bobbit-owned
							api: sample.api,
							baseUrl: sample.baseUrl,
							cost: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 }, // user edit
							contextWindow: sample.contextWindow,
							maxTokens: sample.maxTokens,
							reasoning: sample.reasoning,
							input: sample.input,
						},
					],
				},
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(seeded, null, 2));
		writeOpenAIModelAdditions();
		const data = readModels();
		const e = findEntry(data, sample.provider, sample.id);
		// User-edited cost is preserved.
		assert.deepEqual(e.cost, { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 }, "user cost edit must be preserved");
		// name was equal-to-default → still default afterwards.
		assert.equal(e.name, sample.name);
	});

	it("Bobbit-owned duplicate is removed once pi-ai ships the same model", () => {
		const sample = OPENAI_MODEL_ADDITIONS.find((m) => m.provider === "openai-codex" && m.id === "gpt-5.5");
		assert.ok(sample && hasBuiltIn(sample.provider, sample.id), "expected openai-codex/gpt-5.5 to be a pi-ai built-in");
		const seeded = {
			providers: {
				[sample.provider]: {
					models: [
						{
							id: sample.id,
							name: sample.name,
							api: sample.api,
							baseUrl: sample.baseUrl,
							cost: sample.cost,
							contextWindow: sample.contextWindow,
							maxTokens: sample.maxTokens,
							reasoning: sample.reasoning,
							thinkingLevelMap: sample.thinkingLevelMap,
							input: sample.input,
						},
					],
				},
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(seeded, null, 2));
		writeOpenAIModelAdditions();
		const data = readModels();
		assert.equal(findOptionalEntry(data, sample.provider, sample.id), undefined);
	});

	it("user-edited duplicate keeps edits but migrates Bobbit-owned fields to built-in metadata", () => {
		const sample = OPENAI_MODEL_ADDITIONS.find((m) => m.provider === "openai-codex" && m.id === "gpt-5.5");
		assert.ok(sample, "expected legacy openai-codex/gpt-5.5 addition");
		const builtIn = getModels(sample.provider as any).find((m: any) => m.id === sample.id) as any;
		assert.ok(builtIn, "expected pi-ai built-in metadata");
		const seeded = {
			providers: {
				[sample.provider]: {
					models: [
						{
							id: sample.id,
							name: "User Custom Name",
							api: sample.api,
							baseUrl: sample.baseUrl,
							cost: sample.cost,
							contextWindow: sample.contextWindow,
							maxTokens: sample.maxTokens,
							reasoning: sample.reasoning,
							thinkingLevelMap: sample.thinkingLevelMap,
							input: sample.input,
						},
					],
				},
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(seeded, null, 2));
		writeOpenAIModelAdditions();
		const data = readModels();
		const e = findEntry(data, sample.provider, sample.id);
		assert.equal(e.name, "User Custom Name");
		assert.equal(e.contextWindow, builtIn.contextWindow);
		assert.deepEqual(e.thinkingLevelMap, builtIn.thinkingLevelMap);
	});

	it("missing fields are filled in from defaults", () => {
		// Seed a sparse entry that lacks `cost` and `baseUrl`.
		const sample = customAdditionSample();
		const seeded = {
			providers: {
				[sample.provider]: {
					models: [
						{ id: sample.id, name: "User Custom Name" },
					],
				},
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(seeded, null, 2));
		writeOpenAIModelAdditions();
		const data = readModels();
		const e = findEntry(data, sample.provider, sample.id);
		// User-edited name preserved.
		assert.equal(e.name, "User Custom Name");
		// Missing fields backfilled.
		assert.equal(e.baseUrl, sample.baseUrl);
		assert.deepEqual(e.cost, sample.cost);
		assert.equal(e.api, sample.api);
	});
});

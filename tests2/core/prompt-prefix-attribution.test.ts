// v2-native — prompt-prefix attribution core and privacy persistence coverage. Listed in tests-map.json `v2Native`.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { ContextTraceStore } from "../../src/server/agent/context-trace-store.ts";
import {
	canonicalJson,
	comparePromptPrefixSnapshots,
	createPrefixSeed,
	createPromptPrefixSnapshot,
	createSnapshotFromSeed,
	PrefixAttributionRecorder,
	providerCacheTelemetryFromCounters,
	type PrefixAttribution,
	type PrefixComponent,
} from "../../src/server/agent/prompt-prefix-attribution.ts";
import { createMemFs } from "../harness/mem-fs.js";

const STATE_DIR = path.resolve("/memfs/prompt-prefix-attribution");
const SESSION = "prefix-session";
const COMPONENTS: Record<PrefixComponent, unknown> = {
	system: { sections: [{ label: "Identity", content: "system sentinel" }] },
	tools: { selected: [{ name: "bash", schema: { type: "object" } }] },
	"dynamic-context": { sessionSetup: [], beforePrompt: [] },
	skills: { catalog: "skill sentinel" },
};

function snapshot(sequence: number, components = COMPONENTS) {
	return createPromptPrefixSnapshot({
		ts: sequence,
		sessionId: SESSION,
		sequence,
		boundary: "dispatch",
		model: { provider: "openai", id: "gpt-test" },
		compactionEpoch: 0,
		components,
	});
}

function mutate(kind: PrefixComponent): Record<PrefixComponent, unknown> {
	return { ...COMPONENTS, [kind]: { altered: kind } };
}

describe("prompt prefix attribution", () => {
	it("canonicalizes object keys while preserving array order and produces full SHA-256 hashes", () => {
		expect(canonicalJson({ b: undefined, a: { z: 1, c: 2 } })).toBe('{"a":{"c":2,"z":1},"b":null}');
		const protoKey = JSON.parse('{"__proto__":{"sentinel":"must-be-hashed"},"a":1}');
		expect(canonicalJson(protoKey)).toBe('{"__proto__":{"sentinel":"must-be-hashed"},"a":1}');
		expect(snapshot(0, { ...COMPONENTS, tools: protoKey }).components[1].sha256)
			.not.toBe(snapshot(0, { ...COMPONENTS, tools: { a: 1 } }).components[1].sha256);
		expect(snapshot(0, { ...COMPONENTS, tools: [{ name: "a" }, { name: "b" }] }).components[1].sha256)
			.not.toBe(snapshot(0, { ...COMPONENTS, tools: [{ name: "b" }, { name: "a" }] }).components[1].sha256);
		for (const component of snapshot(0).components) expect(component.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("names exactly the changed component, multiple changes, and aggregate-only anomalies", () => {
		const baseline = snapshot(0);
		for (const kind of ["system", "tools", "dynamic-context", "skills"] as const) {
			const result = comparePromptPrefixSnapshots(snapshot(1, mutate(kind)), baseline);
			expect(result).toMatchObject({ comparison: "changed", culprit: kind, changed: [kind] });
		}
		expect(comparePromptPrefixSnapshots(snapshot(1), baseline)).toMatchObject({ comparison: "stable", comparableTo: 0 });
		expect(comparePromptPrefixSnapshots(snapshot(1, mutate("system")), baseline)).toMatchObject({ culprit: "system" });
		expect(comparePromptPrefixSnapshots(snapshot(1, { ...mutate("system"), tools: { changed: "also" } }), baseline))
			.toMatchObject({ culprit: "multiple", changed: ["system", "tools"] });
		const aggregateOnly = { ...snapshot(1), aggregateSha256: "f".repeat(64) };
		expect(comparePromptPrefixSnapshots(aggregateOnly, baseline)).toMatchObject({ culprit: "unattributable", changed: [] });
	});

	it("attributes typed model and compaction boundaries with model-switch precedence", () => {
		const baseline = snapshot(0);
		expect(comparePromptPrefixSnapshots({ ...snapshot(1), model: { provider: "anthropic", id: "claude" } }, baseline))
			.toMatchObject({ comparison: "boundary", boundaryReason: "model-switch" });
		expect(comparePromptPrefixSnapshots({ ...snapshot(1), compactionEpoch: 1 }, baseline))
			.toMatchObject({ comparison: "boundary", boundaryReason: "compaction" });
		expect(comparePromptPrefixSnapshots({ ...snapshot(1), model: { provider: "anthropic", id: "claude" }, compactionEpoch: 1 }, baseline))
			.toMatchObject({ comparison: "boundary", boundaryReason: "model-switch" });
	});

	it("treats missing cache telemetry as unknown", () => {
		expect(providerCacheTelemetryFromCounters()).toBe("unknown");
		expect(providerCacheTelemetryFromCounters({ hit: 0, miss: 0 })).toBe("unknown");
		expect(providerCacheTelemetryFromCounters({ hit: 2 })).toBe("hit");
		expect(providerCacheTelemetryFromCounters({ miss: 2 })).toBe("miss");
	});

	it("persists enum-validated boundary reasons while accepting old rows without one", () => {
		const memfs = createMemFs();
		const store = new ContextTraceStore(STATE_DIR, memfs);
		const boundary = comparePromptPrefixSnapshots({ ...snapshot(1), compactionEpoch: 1 }, snapshot(0));
		store.appendPrefixAttribution(SESSION, boundary);
		const legacy = { ...boundary };
		delete legacy.boundaryReason;
		store.appendPrefixAttribution(SESSION, legacy);
		expect(store.readPrefixAttribution(SESSION)).toMatchObject([
			{ comparison: "boundary", boundaryReason: "compaction" },
			{ comparison: "boundary" },
		]);
		expect(store.readPrefixAttribution(SESSION)[1]).not.toHaveProperty("boundaryReason");
		expect(() => store.appendPrefixAttribution(SESSION, { ...boundary, boundaryReason: "unknown" } as any)).toThrow("Invalid prompt-prefix attribution entry");
		expect(() => store.appendPrefixAttribution(SESSION, { ...snapshot(2), comparison: "stable", boundaryReason: "compaction" } as any)).toThrow("Invalid prompt-prefix attribution entry");
	});

	it("finalizes only the active pending sequence and persists a hash-only durable row", () => {
		const memfs = createMemFs();
		const store = new ContextTraceStore(STATE_DIR, memfs);
		const recorder = new PrefixAttributionRecorder(SESSION, store);
		const seed = createPrefixSeed({
			system: "SYSTEM-RAW-SENTINEL",
			tools: "TOOLS-RAW-SENTINEL",
			skills: "SKILLS-RAW-SENTINEL",
			sessionSetupDynamicContext: "SETUP-RAW-SENTINEL",
		});
		const first = recorder.beginDispatch(seed, { ts: 1, compactionEpoch: 0 });
		const retry = recorder.beginDispatch(seed, { ts: 2, compactionEpoch: 0 });
		expect(recorder.finalizeBeforePrompt(first.sequence, { beforePromptDynamicContext: "LATE-RAW-SENTINEL" })).toBeUndefined();
		const row = recorder.finalizeBeforePrompt(retry.sequence, { ts: 3, beforePromptDynamicContext: "DYNAMIC-RAW-SENTINEL" });
		expect(row).toMatchObject({ comparison: "changed", culprit: "dynamic-context", boundary: "before-prompt" });

		const persisted = new ContextTraceStore(STATE_DIR, memfs).readPrefixAttribution(SESSION);
		expect(persisted).toHaveLength(2); // The replaced dispatch is retained as fallback, then retry finalizes.
		expect(persisted.at(-1)).toEqual(row);
		const file = path.join(STATE_DIR, "session-context-trace", `${SESSION}.prefix.jsonl`);
		const jsonl = memfs.readFileSync(file, "utf8");
		for (const sentinel of ["SYSTEM-RAW-SENTINEL", "TOOLS-RAW-SENTINEL", "SKILLS-RAW-SENTINEL", "SETUP-RAW-SENTINEL", "DYNAMIC-RAW-SENTINEL"]) {
			expect(jsonl).not.toContain(sentinel);
		}
	});

	it("only stores the documented allow-list, even for caller-supplied extra fields", () => {
		const memfs = createMemFs();
		const store = new ContextTraceStore(STATE_DIR, memfs);
		const entry = { ...comparePromptPrefixSnapshots(snapshot(1)), rawPrompt: "DO-NOT-PERSIST", components: snapshot(1).components } as PrefixAttribution & { rawPrompt: string };
		store.appendPrefixAttribution(SESSION, entry);
		const file = path.join(STATE_DIR, "session-context-trace", `${SESSION}.prefix.jsonl`);
		expect(memfs.readFileSync(file, "utf8")).not.toContain("DO-NOT-PERSIST");
		expect(store.readPrefixAttribution(SESSION, 1001)).toHaveLength(1);
	});

	it("includes the setup and final hook blocks in the dynamic component", () => {
		const seed = createPrefixSeed({ system: "s", tools: "t", skills: "k", sessionSetupDynamicContext: ["setup"] });
		const base = createSnapshotFromSeed({ seed, ts: 1, sessionId: SESSION, sequence: 0, boundary: "dispatch", compactionEpoch: 0 });
		const final = createSnapshotFromSeed({ seed, ts: 2, sessionId: SESSION, sequence: 1, boundary: "before-prompt", compactionEpoch: 0, beforePromptDynamicContext: ["turn"] });
		expect(comparePromptPrefixSnapshots(final, base)).toMatchObject({ culprit: "dynamic-context" });
	});
});

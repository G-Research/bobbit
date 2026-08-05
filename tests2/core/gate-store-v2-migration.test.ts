import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GateStore, type GateSignal, type GateState } from "../../src/server/agent/gate-store.js";
import {
	GATE_STORE_SCHEMA_VERSION,
	gateStoreV2Root,
	goalRecordPath,
	legacyRecordPath,
	payloadPath,
	safeReadManagedGatePayload,
	type GateStoreV2GoalRecord,
	type GateStoreV2LegacyRecord,
	type GateStoreV2Manifest,
} from "../../src/server/agent/gate-store-v2-persistence.js";
import { buildArtifactLookup, resolveArtifactFromLookup, validateRetainedArtifactPath } from "../../src/server/gate-artifacts.js";
import { realFs, type FsLike } from "../../src/server/gateway-deps.js";

const roots: string[] = [];

function tempState(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-gate-v2-${label}-`));
	roots.push(root);
	const stateDir = path.join(root, ".bobbit", "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function step(name: string, output: string, overrides: Partial<GateSignal["verification"]["steps"][number]> = {}): GateSignal["verification"]["steps"][number] {
	return {
		name,
		type: "command",
		passed: true,
		status: "passed",
		output,
		duration_ms: 12,
		...overrides,
	};
}

function signal(id: string, ordinal: number, overrides: Partial<GateSignal> = {}): GateSignal {
	return {
		id,
		gateId: "verification",
		goalId: "goal-live",
		sessionId: `session-${ordinal}`,
		timestamp: 1_700_000_000_000 + ordinal,
		commitSha: `commit-${ordinal}`,
		content: `content-${ordinal}`,
		contentVersion: ordinal + 1,
		verification: { status: "passed", steps: [step(`step-${ordinal}`, `output-${ordinal}`)] },
		...overrides,
	};
}

function gate(goalId: string, gateId: string, signals: GateSignal[], overrides: Partial<GateState> = {}): GateState {
	return {
		goalId,
		gateId,
		status: "failed",
		currentContent: `# Current truth for ${gateId}`,
		currentContentVersion: 17,
		currentMetadata: { owner: "migration-test", cacheKey: "preserve-me" },
		verificationCacheInvalidatedAt: 1_699_999_999_999,
		signals,
		updatedAt: 1_700_000_100_000,
		...overrides,
	};
}

function writeLegacy(stateDir: string, gates: GateState[]): string {
	const json = JSON.stringify(gates);
	fs.writeFileSync(path.join(stateDir, "gates.json"), json, "utf8");
	return json;
}

// Affected-test reader audit: these helpers only inspect files created beneath
// tempState()'s isolated OS-temporary roots, never repository inputs. Using the
// injected real filesystem seam keeps that generated-output ownership explicit.
function readGeneratedText(file: string): string {
	return realFs.readFileSync(file, "utf8");
}

function readJson<T>(file: string): T {
	return JSON.parse(readGeneratedText(file)) as T;
}

function fileSnapshot(root: string): Array<[string, string]> {
	const rows: Array<[string, string]> = [];
	const pending = [root];
	while (pending.length > 0) {
		const dir = pending.pop()!;
		for (const entry of realFs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) pending.push(file);
			else rows.push([path.relative(root, file).replace(/\\/g, "/"), createHash("sha256").update(realFs.readFileSync(file)).digest("hex")]);
		}
	}
	return rows.sort(([a], [b]) => a.localeCompare(b));
}

function interruptingFs(shouldFail: (from: string, to: string) => boolean): FsLike {
	let failed = false;
	return {
		...realFs,
		renameSync(from, to) {
			if (!failed && shouldFail(path.resolve(String(from)), path.resolve(String(to)))) {
				failed = true;
				throw new Error("injected gate v2 migration interruption");
			}
			return fs.renameSync(from, to);
		},
	};
}

describe("GateStore v1 to v2 migration", () => {
	it("preserves gate truth, ordering, verdicts, bypass audit, cache boundary, and durable diagnostics while externalizing inline bodies", () => {
		const stateDir = tempState("truth");
		const retainedRoot = path.join(stateDir, "gate-diagnostics", "goal-live", "verification", "signal-retained", "command");
		const retainedArtifact = path.join(retainedRoot, "artifacts", "result.md");
		const retainedStdout = path.join(retainedRoot, "stdout.log");
		fs.mkdirSync(path.dirname(retainedArtifact), { recursive: true });
		fs.writeFileSync(retainedArtifact, "authoritative retained artifact", "utf8");
		fs.writeFileSync(retainedStdout, "authoritative retained stdout", "utf8");
		const missingArtifact = path.join(retainedRoot, "artifacts", "missing.md");
		const retained = signal("signal-retained", 0, {
			verification: {
				status: "failed",
				steps: [step("retained command", "duplicated inline stdout", {
					passed: false,
					status: "failed",
					diagnostics: {
						type: "retained-command-diagnostics",
						createdAt: 1_700_000_000_000,
						baseDir: retainedRoot,
						stdout: { path: retainedStdout, bytes: 29, lines: 1 },
						artifacts: [
							{ path: retainedArtifact, relativePath: "test-results/result.md", sourcePath: retainedArtifact, bytes: 31, kind: "test-results", content: "duplicated retained artifact" },
							{ path: missingArtifact, relativePath: "test-results/missing.md", sourcePath: missingArtifact, bytes: 32, kind: "test-results", content: "managed missing artifact fallback" },
						],
					},
				})],
			},
		});
		const externalized = signal("signal-externalized", 1, {
			verification: { status: "passed", steps: [step("review", "managed output fallback", { type: "llm-review", artifact: { content: "managed primary artifact", contentType: "text/markdown" } })] },
		});
		const bypass = signal("signal-bypass", 2, {
			sessionId: "human-bypass",
			commitSha: "",
			metadata: { bypass: "true", whyBypassed: "operator override", whoAmI: "tester", bypassedAt: "1700000000002" },
			verification: { status: "passed", steps: [] },
		});
		const running = signal("signal-running", 3, { verification: { status: "running", steps: [step("still running", "live tail", { status: "running", passed: false })] } });
		const legacyJson = writeLegacy(stateDir, [
			gate("goal-live", "verification", [retained, externalized, bypass, running]),
			gate("goal-archived", "audit", [signal("archived-signal", 0, { goalId: "goal-archived", gateId: "audit" })], { status: "passed" }),
		]);

		const store = new GateStore(stateDir);
		const root = gateStoreV2Root(stateDir);
		const manifest = readJson<GateStoreV2Manifest>(path.join(root, "manifest.json"));
		expect(manifest).toMatchObject({
			schemaVersion: GATE_STORE_SCHEMA_VERSION,
			state: "complete",
			sourceFile: "gates.json",
			sourceBytes: Buffer.byteLength(legacyJson),
			gateCount: 2,
			signalCount: 5,
			bypassCount: 1,
		});
		expect(manifest.sourceSha256).toBe(createHash("sha256").update(legacyJson).digest("hex"));
		expect(manifest.externalizedBytes).toBeGreaterThan(0);
		expect(manifest.payloadBytes).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(stateDir, "gates.json"))).toBe(false);
		expect(readGeneratedText(path.join(stateDir, "gates.json.v1-retired"))).toBe(legacyJson);

		const current = store.getGate("goal-live", "verification")!;
		expect(current).toMatchObject({
			status: "failed",
			currentContent: "# Current truth for verification",
			currentContentVersion: 17,
			currentMetadata: { owner: "migration-test", cacheKey: "preserve-me" },
			verificationCacheInvalidatedAt: 1_699_999_999_999,
		});
		expect(current.signals.map(row => row.id)).toEqual(["signal-retained", "signal-externalized", "signal-bypass", "signal-running"]);
		expect(current.signals.map(row => row.persistenceOrdinal)).toEqual([0, 1, 2, 3]);
		expect(current.signals.map(row => row.verification.status)).toEqual(["failed", "passed", "passed", "running"]);
		expect(store.getLatestBypassSignal(current)?.metadata).toMatchObject({ whyBypassed: "operator override", whoAmI: "tester" });
		expect(store.getGate("goal-archived", "audit")?.signals.map(row => row.id)).toEqual(["archived-signal"]);

		const archive = readJson<GateStoreV2LegacyRecord>(legacyRecordPath(root, "goal-live"));
		const archivedRows = archive.gates.find(row => row.gateId === "verification")!.signals;
		const retainedStep = archivedRows[0]!.verification.steps[0]!;
		expect(retainedStep.output).toBe("");
		expect(retainedStep.outputRef).toBeUndefined();
		expect(retainedStep.diagnostics?.stdout?.path).toBe(retainedStdout);
		const authoritativeArtifact = retainedStep.diagnostics!.artifacts![0]!;
		expect(authoritativeArtifact.path).toBe(retainedArtifact);
		expect(authoritativeArtifact.content).toBeUndefined();
		expect(authoritativeArtifact.contentRef).toBeUndefined();
		const missingFallback = retainedStep.diagnostics!.artifacts![1]!;
		expect(missingFallback.content).toBeUndefined();
		expect(safeReadManagedGatePayload(missingFallback.contentRef!)).toBe("managed missing artifact fallback");
		const lookup = buildArtifactLookup(retainedStep.diagnostics);
		const resolved = resolveArtifactFromLookup(lookup, "test-results/missing.md");
		expect(validateRetainedArtifactPath(retainedStep.diagnostics!, resolved)).toBe(missingFallback.contentRef!.path);
		const managedStep = archivedRows[1]!.verification.steps[0]!;
		expect(managedStep.output).toBe("");
		expect(safeReadManagedGatePayload(managedStep.outputRef!)).toBe("managed output fallback");
		expect(managedStep.artifact?.content).toBe("");
		expect(safeReadManagedGatePayload(managedStep.artifact!.contentRef!)).toBe("managed primary artifact");
	});

	it.each(["goal-shard", "atomic-publication"] as const)("recovers idempotently after an injected %s interruption", (phase) => {
		const stateDir = tempState(`interrupt-${phase}`);
		const source = writeLegacy(stateDir, [gate("goal-live", "verification", [signal("signal-0", 0)])]);
		const root = gateStoreV2Root(stateDir);
		const injected = interruptingFs((from, to) => phase === "goal-shard"
			? to === goalRecordPath(`${root}.staging`, "goal-live")
			: from === path.resolve(`${root}.staging`) && to === path.resolve(root));

		expect(() => new GateStore(stateDir, injected)).toThrow(/injected gate v2 migration interruption/);
		expect(readGeneratedText(path.join(stateDir, "gates.json"))).toBe(source);
		expect(fs.existsSync(path.join(root, "manifest.json"))).toBe(false);
		expect(fs.existsSync(`${root}.staging`)).toBe(false);

		const recovered = new GateStore(stateDir);
		expect(recovered.getGate("goal-live", "verification")?.signals.map(row => row.id)).toEqual(["signal-0"]);
		expect(readJson<GateStoreV2Manifest>(path.join(root, "manifest.json")).state).toBe("complete");
		expect(readGeneratedText(path.join(stateDir, "gates.json.v1-retired"))).toBe(source);
	});

	it("rebuilds a crash-left incomplete v2 directory from the still-authoritative legacy file", () => {
		const stateDir = tempState("stale-v2");
		writeLegacy(stateDir, [gate("goal-live", "verification", [signal("signal-0", 0)])]);
		const root = gateStoreV2Root(stateDir);
		fs.mkdirSync(path.join(root, "goals"), { recursive: true });
		fs.writeFileSync(path.join(root, "goals", "partial.json"), "partial", "utf8");

		const recovered = new GateStore(stateDir);
		expect(recovered.getGate("goal-live", "verification")?.signals[0]?.id).toBe("signal-0");
		expect(fs.existsSync(path.join(root, "goals", "partial.json"))).toBe(false);
		expect(readJson<GateStoreV2Manifest>(path.join(root, "manifest.json")).state).toBe("complete");
	});

	it("treats a complete published v2 manifest as authoritative when retiring v1 is interrupted", () => {
		const stateDir = tempState("retire");
		const source = writeLegacy(stateDir, [gate("goal-live", "verification", [signal("signal-0", 0)])]);
		const injected = interruptingFs((from, to) => from === path.resolve(path.join(stateDir, "gates.json")) && to.endsWith("gates.json.v1-retired"));
		const store = new GateStore(stateDir, injected);
		expect(store.getGate("goal-live", "verification")?.signals[0]?.id).toBe("signal-0");
		expect(readGeneratedText(path.join(stateDir, "gates.json"))).toBe(source);
		const before = fileSnapshot(gateStoreV2Root(stateDir));

		const restarted = new GateStore(stateDir);
		expect(restarted.getGate("goal-live", "verification")?.signals[0]?.id).toBe("signal-0");
		expect(fileSnapshot(gateStoreV2Root(stateDir))).toEqual(before);
	});

	it("does not rewrite an already migrated store and keeps project-scoped archived history isolated", () => {
		const projectA = tempState("project-a");
		const projectB = tempState("project-b");
		writeLegacy(projectA, [
			gate("live-a", "gate-a", [signal("live-a-signal", 0, { goalId: "live-a", gateId: "gate-a" })]),
			gate("archived-a", "gate-a", [signal("archived-a-signal", 0, { goalId: "archived-a", gateId: "gate-a" })]),
		]);
		writeLegacy(projectB, [gate("archived-b", "gate-b", [signal("archived-b-signal", 0, { goalId: "archived-b", gateId: "gate-b" })])]);

		const firstA = new GateStore(projectA);
		expect(firstA.getGate("archived-a", "gate-a")?.signals[0]?.id).toBe("archived-a-signal");
		expect(fs.existsSync(path.join(projectB, "gates.json"))).toBe(true);
		expect(fs.existsSync(gateStoreV2Root(projectB))).toBe(false);
		const snapshotA = fileSnapshot(gateStoreV2Root(projectA));
		const secondA = new GateStore(projectA);
		expect(secondA.getGate("live-a", "gate-a")?.signals[0]?.id).toBe("live-a-signal");
		expect(fileSnapshot(gateStoreV2Root(projectA))).toEqual(snapshotA);

		const storeB = new GateStore(projectB);
		expect(storeB.getGate("archived-b", "gate-b")?.signals[0]?.id).toBe("archived-b-signal");
		expect(storeB.getGate("archived-a", "gate-a")).toBeUndefined();
		expect(readJson<GateStoreV2GoalRecord>(goalRecordPath(gateStoreV2Root(projectB), "archived-b")).goalId).toBe("archived-b");
	});

	it("rejects forged, misplaced, truncated, and hash-mismatched managed payload references", async () => {
		const stateDir = tempState("payload-security");
		const store = new GateStore(stateDir);
		store.initGatesForGoal("goal-live", ["verification"]);
		store.recordSignal(signal("signal-secure", 0, {
			verification: { status: "failed", steps: [step("secure", "authoritative managed body", { passed: false, status: "failed" })] },
		}));
		await store.flush();
		const record = readJson<GateStoreV2GoalRecord>(goalRecordPath(gateStoreV2Root(stateDir), "goal-live"));
		const ref = record.gates[0]!.signals[0]!.verification.steps[0]!.outputRef!;
		expect(safeReadManagedGatePayload(ref)).toBe("authoritative managed body");
		expect(safeReadManagedGatePayload({ ...ref, kind: "not-managed" as never })).toBeUndefined();
		expect(safeReadManagedGatePayload({ ...ref, sha256: "f".repeat(64) })).toBeUndefined();
		expect(safeReadManagedGatePayload({ ...ref, bytes: ref.bytes + 1 })).toBeUndefined();
		expect(safeReadManagedGatePayload({ ...ref, path: path.join(path.dirname(ref.path), "..", `${ref.sha256}.payload`) })).toBeUndefined();
		fs.writeFileSync(ref.path, "same-length-but-wrong-content".slice(0, ref.bytes).padEnd(ref.bytes, "!"), "utf8");
		expect(safeReadManagedGatePayload(ref)).toBeUndefined();
	});

	it("reports bounded body-free migration, size, cutoff, and persistence metrics", async () => {
		const stateDir = tempState("report");
		writeLegacy(stateDir, [gate("goal-live", "verification", [signal("signal-0", 0, { verification: { status: "passed", steps: [step("large", "SECRET_INLINE_BODY".repeat(4096), { type: "llm-review" })] } })])]);
		const store = new GateStore(stateDir);
		store.initGatesForGoal("post-v2", ["gate"]);
		store.updateGateContent("post-v2", "gate", "x".repeat(8 * 1024 * 1024 + 1), 1);
		await store.flush();
		const report = store.getMaintenanceReport();
		const serialized = JSON.stringify(report);

		expect(report.schemaVersion).toBe(2);
		expect(report.migration).toMatchObject({ state: "complete", gateCount: 1, signalCount: 1 });
		expect(report.cutoffs).toEqual({ hotSignals: 32, ordinarySignals: 256, ordinaryBytes: 8 * 1024 * 1024 });
		expect(report.totals).toMatchObject({ goalShards: 2, legacyShards: 1 });
		expect(report.totals.payloadBytes).toBeGreaterThan(0);
		expect(report.largest.length).toBeLessThanOrEqual(20);
		expect(report.largest.some(row => row.kind === "goal" && row.exceedsLimit)).toBe(true);
		expect(report.metrics).toMatchObject({ shardsWritten: 1, retention: report.cutoffs });
		expect(report.metrics.serializationMs).toBeGreaterThanOrEqual(0);
		expect(report.metrics.writeMs).toBeGreaterThanOrEqual(0);
		expect(serialized).not.toContain("SECRET_INLINE_BODY");
		expect(serialized).not.toContain(stateDir);
		expect(serialized.length).toBeLessThan(16_000);
		for (const row of report.largest.filter(row => row.kind === "payload")) {
			expect(row.name).toMatch(/^[a-f0-9]{64}\.payload$/);
			const hash = row.name.slice(0, -".payload".length);
			expect(fs.existsSync(payloadPath(gateStoreV2Root(stateDir), hash))).toBe(true);
		}
	});
});

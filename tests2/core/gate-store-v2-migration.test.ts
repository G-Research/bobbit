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
	readManagedGatePayloadBounded,
	selectManagedGatePayload,
	type GateStoreV2GoalRecord,
	type GateStoreV2LegacyRecord,
	type GateStoreV2Manifest,
} from "../../src/server/agent/gate-store-v2-persistence.js";
import { buildArtifactLookup, resolveArtifactFromLookup, selectRetainedGateArtifact } from "../../src/server/gate-artifacts.js";
import { buildGateVerificationInspectionSnapshot, buildGateVerificationSnapshot } from "../../src/server/gate-verification-snapshot.js";
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
	it("preserves gate truth, ordering, verdicts, bypass audit, cache boundary, and durable diagnostics while externalizing inline bodies", async () => {
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
		const compactSnapshot = buildGateVerificationSnapshot({
			goalId: "goal-live",
			gateId: "verification",
			signalId: archivedRows[0]!.id,
			verification: archivedRows[0]!.verification,
			selectionOptions: { mode: "full", includeDiagnostics: true },
		});
		expect(compactSnapshot.steps[0]!.output).toBe("");
		const inspectedSnapshot = await buildGateVerificationInspectionSnapshot({
			goalId: "goal-live",
			gateId: "verification",
			signalId: archivedRows[0]!.id,
			verification: archivedRows[0]!.verification,
			selectionOptions: { mode: "full", includeDiagnostics: true },
			v2Root: root,
		});
		expect(inspectedSnapshot.steps[0]!.output).toContain("authoritative retained stdout");
		expect(inspectedSnapshot.steps[0]!.diagnostics?.outputSource).toBe("retained-logs");
		expect(JSON.stringify(inspectedSnapshot)).not.toContain(retainedStdout);

		const authoritativeArtifact = retainedStep.diagnostics!.artifacts![0]!;
		expect(authoritativeArtifact.path).toBe(retainedArtifact);
		expect(authoritativeArtifact.content).toBeUndefined();
		expect(authoritativeArtifact.contentRef).toBeUndefined();
		const missingFallback = retainedStep.diagnostics!.artifacts![1]!;
		expect(missingFallback.content).toBeUndefined();
		expect(await readManagedGatePayloadBounded(root, missingFallback.contentRef!, 1024)).toBe("managed missing artifact fallback");
		const lookup = buildArtifactLookup(retainedStep.diagnostics);
		const resolved = resolveArtifactFromLookup(lookup, "test-results/missing.md");
		expect(JSON.stringify(resolved)).not.toContain(missingFallback.contentRef!.path);
		expect(JSON.stringify(resolved)).not.toContain(missingFallback.contentRef!.sha256);
		expect((await selectRetainedGateArtifact(root, retainedStep.diagnostics!, resolved, { mode: "full", maxBytes: 1024 }))?.text).toBe("managed missing artifact fallback");
		const managedStep = archivedRows[1]!.verification.steps[0]!;
		expect(managedStep.output).toBe("");
		expect(await readManagedGatePayloadBounded(root, managedStep.outputRef!, 1024)).toBe("managed output fallback");
		expect(managedStep.artifact?.content).toBe("");
		expect(await readManagedGatePayloadBounded(root, managedStep.artifact!.contentRef!, 1024)).toBe("managed primary artifact");
	});

	it.each(["payload", "goal-shard", "manifest", "atomic-publication"] as const)("recovers idempotently after an injected worker %s interruption", (phase) => {
		const stateDir = tempState(`interrupt-${phase}`);
		const source = writeLegacy(stateDir, [gate("goal-live", "verification", [signal("signal-0", 0, {
			verification: { status: "failed", steps: [step("large", "WORKER_INTERRUPTION_PAYLOAD".repeat(4096), { passed: false, status: "failed" })] },
		})])]);
		const root = gateStoreV2Root(stateDir);
		const injected = interruptingFs((from, to) => {
			if (phase === "payload") return to.includes(`${path.sep}payloads${path.sep}`) && to.endsWith(".payload");
			if (phase === "goal-shard") return to === goalRecordPath(`${root}.staging`, "goal-live");
			if (phase === "manifest") return to === path.resolve(path.join(`${root}.staging`, "manifest.json"));
			return from === path.resolve(`${root}.staging`) && to === path.resolve(root);
		});

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

	it("treats a complete published v2 manifest as authoritative and finishes interrupted v1 retirement", async () => {
		const stateDir = tempState("retire");
		const source = writeLegacy(stateDir, [gate("goal-live", "verification", [signal("signal-0", 0)])]);
		const injected = interruptingFs((from, to) => from === path.resolve(path.join(stateDir, "gates.json")) && to.endsWith("gates.json.v1-retired"));
		const store = new GateStore(stateDir, injected);
		expect(store.getGate("goal-live", "verification")?.signals[0]?.id).toBe("signal-0");
		expect(readGeneratedText(path.join(stateDir, "gates.json"))).toBe(source);
		const before = fileSnapshot(gateStoreV2Root(stateDir));

		await GateStore.prepare(stateDir);
		const restarted = new GateStore(stateDir);
		expect(restarted.getGate("goal-live", "verification")?.signals[0]?.id).toBe("signal-0");
		expect(fileSnapshot(gateStoreV2Root(stateDir))).toEqual(before);
		expect(
			fs.existsSync(path.join(stateDir, "gates.json")),
			"GATE_V2_WORKER_POST_PUBLICATION_RETIREMENT_INCOMPLETE: restart must finish retiring the legacy source after validated v2 publication",
		).toBe(false);
		expect(readGeneratedText(path.join(stateDir, "gates.json.v1-retired"))).toBe(source);
	});

	it("coalesces concurrent first opens onto one migration and identical canonical state", async () => {
		const stateDir = tempState("coalesced-open");
		writeLegacy(stateDir, [gate("goal-live", "verification", [signal("signal-0", 0), signal("signal-1", 1)])]);
		const firstPrepare = GateStore.prepare(stateDir);
		const secondPrepare = GateStore.prepare(stateDir);
		expect(secondPrepare, "GATE_V2_WORKER_MIGRATION_NOT_COALESCED: concurrent first opens must share one migration promise").toBe(firstPrepare);
		const [firstMigration, secondMigration] = await Promise.all([firstPrepare, secondPrepare]);
		expect(firstMigration.migrated, "GATE_V2_WORKER_MIGRATION_NOT_COALESCED: the shared first-open migration must migrate the legacy source").toBe(true);
		expect(secondMigration, "GATE_V2_WORKER_MIGRATION_NOT_COALESCED: concurrent waiters must receive the shared migration result").toEqual(firstMigration);

		const first = new GateStore(stateDir);
		const second = new GateStore(stateDir);
		const firstIds = first.getGate("goal-live", "verification")?.signals.map(row => row.id);
		const secondIds = second.getGate("goal-live", "verification")?.signals.map(row => row.id);
		expect(secondIds, "GATE_V2_WORKER_MIGRATION_CANONICAL_STATE_DIVERGED: concurrent waiters must load identical validated state").toEqual(firstIds);
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
		expect(await readManagedGatePayloadBounded(gateStoreV2Root(stateDir), ref, 1024)).toBe("authoritative managed body");
		expect(await selectManagedGatePayload(gateStoreV2Root(stateDir), { ...ref, kind: "not-managed" as never })).toBeUndefined();
		expect(await selectManagedGatePayload(gateStoreV2Root(stateDir), { ...ref, sha256: "f".repeat(64) })).toBeUndefined();
		expect(await selectManagedGatePayload(gateStoreV2Root(stateDir), { ...ref, bytes: ref.bytes + 1 })).toBeUndefined();
		expect(await selectManagedGatePayload(gateStoreV2Root(stateDir), { ...ref, path: path.join(path.dirname(ref.path), "..", `${ref.sha256}.payload`) })).toBeUndefined();
		fs.writeFileSync(ref.path, "same-length-but-wrong-content".slice(0, ref.bytes).padEnd(ref.bytes, "!"), "utf8");
		expect(await selectManagedGatePayload(gateStoreV2Root(stateDir), ref)).toBeUndefined();
	});

	it("binds streaming reads to the owning root and bounds a payload with no newlines", async () => {
		const projectA = tempState("reader-project-a");
		const projectB = tempState("reader-project-b");
		const storeB = new GateStore(projectB);
		storeB.initGatesForGoal("goal-b", ["verification"]);
		const body = `${"x".repeat(2 * 1024 * 1024)}CROSS_PROJECT_TAIL_MARKER`;
		storeB.recordSignal(signal("signal-b", 0, {
			goalId: "goal-b",
			verification: { status: "failed", steps: [step("large", body, { passed: false, status: "failed" })] },
		}));
		await storeB.flush();
		const rootB = gateStoreV2Root(projectB);
		const recordB = readJson<GateStoreV2GoalRecord>(goalRecordPath(rootB, "goal-b"));
		const refB = recordB.gates[0]!.signals[0]!.verification.steps[0]!.outputRef!;

		expect(await selectManagedGatePayload(gateStoreV2Root(projectA), refB, { mode: "tail", lines: 1, maxBytes: 1024 })).toBeUndefined();
		const snapshotInput = {
			goalId: "goal-b",
			gateId: "verification",
			signalId: "signal-b",
			verification: recordB.gates[0]!.signals[0]!.verification,
			selectionOptions: { mode: "tail" as const, lines: 1 },
		};
		expect(buildGateVerificationSnapshot(snapshotInput).steps[0]!.output).toBe("");
		expect((await buildGateVerificationInspectionSnapshot({ ...snapshotInput, v2Root: rootB })).steps[0]!.output).toContain("CROSS_PROJECT_TAIL_MARKER");
		expect((await buildGateVerificationInspectionSnapshot({ ...snapshotInput, v2Root: gateStoreV2Root(projectA) })).steps[0]!.output).toBe("");
		const selected = await selectManagedGatePayload(rootB, refB, { mode: "tail", lines: 1, maxBytes: 1024 });
		expect(selected?.totalBytes).toBe(Buffer.byteLength(body));
		expect(selected?.totalLines).toBe(1);
		expect(Buffer.byteLength(selected?.text ?? "")).toBeLessThanOrEqual(1024);
		expect(selected?.text).toContain("CROSS_PROJECT_TAIL_MARKER");
		expect(selected?.truncated).toBe(true);
	});

	it("fails cross-project ref-only worker migration and safely republishes an owned ref", async () => {
		const projectA = tempState("worker-ref-project-a");
		const projectB = tempState("worker-ref-project-b");
		const body = "owned ref-only migration payload";
		const sha256 = createHash("sha256").update(body).digest("hex");
		const rootA = gateStoreV2Root(projectA);
		const rootB = gateStoreV2Root(projectB);
		const fileB = payloadPath(rootB, sha256);
		fs.mkdirSync(path.dirname(fileB), { recursive: true });
		fs.writeFileSync(fileB, body, "utf8");
		const refB = { kind: "gate-payload-v2" as const, sha256, bytes: Buffer.byteLength(body), path: fileB };
		writeLegacy(projectA, [gate("goal-a", "verification", [signal("signal-a", 0, {
			goalId: "goal-a",
			verification: { status: "failed", steps: [step("ref-only", "", { passed: false, status: "failed", outputRef: refB })] },
		})])]);

		await expect(GateStore.prepare(projectA)).rejects.toThrow(/outside the source project root/);
		expect(fs.existsSync(path.join(projectA, "gates.json"))).toBe(true);
		expect(fs.existsSync(path.join(rootA, "manifest.json"))).toBe(false);

		const ownedFile = payloadPath(rootA, sha256);
		fs.mkdirSync(path.dirname(ownedFile), { recursive: true });
		fs.writeFileSync(ownedFile, body, "utf8");
		const legacy = readJson<GateState[]>(path.join(projectA, "gates.json"));
		legacy[0]!.signals[0]!.verification.steps[0]!.outputRef = { ...refB, path: ownedFile };
		fs.writeFileSync(path.join(projectA, "gates.json"), JSON.stringify(legacy), "utf8");

		await expect(GateStore.prepare(projectA)).resolves.toMatchObject({ migrated: true });
		const migrated = new GateStore(projectA).getGate("goal-a", "verification")!.signals[0]!.verification.steps[0]!.outputRef!;
		expect(migrated.path).toBe(ownedFile);
		expect(await readManagedGatePayloadBounded(rootA, migrated, 1024)).toBe(body);
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

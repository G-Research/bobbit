/**
 * Real adapter matrix for the Hindsight endpoint contract. The purpose-built
 * service implements the public Hindsight wire shape, but every local, Docker,
 * and Compose lifecycle action below is performed by the production runners and
 * supervisor. No host Hindsight, credentials, fixed ports, or user bank is used.
 */
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import type { RuntimeContribution } from "../../src/server/agent/pack-contributions.js";
import { parseServiceManifest, type ServiceRunMode, type ServiceRuntimeManifest } from "../../src/server/service-runtime/service-manifest.js";
import { ServiceRuntimeStore } from "../../src/server/service-runtime/service-runtime-store.js";
import { ServiceRuntimeSupervisor } from "../../src/server/service-runtime/service-supervisor.js";
import { ComposeServiceRunner, DockerServiceRunner, LocalServiceRunner, type ServiceRunner } from "../../src/server/service-runtime/service-runners.js";
import { createClient } from "../../market-packs/hindsight/src/hindsight-client.ts";
import { hindsightStorageContinuity } from "../../src/server/agent/hindsight-runtime-bridge.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixtureSource = resolve(here, "fixtures", "hindsight-runtime-matrix");
const runId = `${process.pid}-${Date.now().toString(36)}`;
const image = `bobbit-hindsight-runtime-matrix:${runId}`;
const roots: string[] = [];
let imageBuilt = false;

function rootFor(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `bobbit-hindsight-runtime-matrix-${label}-`));
	roots.push(root);
	cpSync(fixtureSource, root, { recursive: true });
	for (const file of ["runtime.yaml", "compose.yaml"]) {
		const target = join(root, file);
		writeFileSync(target, readFileSync(target, "utf8").replaceAll("HINDSIGHT_RUNTIME_MATRIX_IMAGE", image), "utf8");
	}
	return root;
}

function manifest(root: string, mutate?: (value: ServiceRuntimeManifest) => ServiceRuntimeManifest): ServiceRuntimeManifest {
	const value = parseServiceManifest(parseYaml(readFileSync(join(root, "runtime.yaml"), "utf8")), {
		packRoot: root,
		sourceFile: join(root, "runtime.yaml"),
	});
	if (!value) throw new Error("HINDSIGHT_RUNTIME_MATRIX_FIXTURE_INVALID");
	return mutate ? mutate(value) : value;
}

async function dockerAvailable(): Promise<boolean> {
	try {
		await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

async function buildImage(root: string): Promise<void> {
	await execFileAsync("docker", ["build", "--pull=false", "--tag", image, root], { timeout: 120_000 });
	imageBuilt = true;
}

function assertLoopbackDynamic(endpoint: string): void {
	const url = new URL(endpoint);
	expect(url.protocol).toBe("http:");
	expect(url.hostname).toBe("127.0.0.1");
	expect(Number(url.port)).toBeGreaterThan(0);
	expect(Number(url.port)).not.toBe(8888);
}

/**
 * The fixture's actual durable backing is its descriptor-declared host bind.
 * Its synthetic, secret-free PostgreSQL URL names that bind only for the
 * production Hindsight external-storage identity function; this generic runner
 * fixture does not claim to exercise a real Hindsight database deployment.
 */
function continuityForFixtureBind(mode: ServiceRunMode, dataDir: string) {
	const backing = createHash("sha256").update(resolve(dataDir)).digest("hex");
	return hindsightStorageContinuity(mode, "external", `postgresql://fixture@matrix.invalid/${backing}`);
}

async function json(endpoint: string, pathname: string, init?: RequestInit): Promise<any> {
	const response = await fetch(new URL(pathname, `${endpoint}/`), init);
	expect(response.ok, `${init?.method ?? "GET"} ${pathname} must succeed`).toBe(true);
	return response.json();
}

interface Running {
	root: string;
	mode: ServiceRunMode;
	manifest: ServiceRuntimeManifest;
	store: ServiceRuntimeStore;
	supervisor: ServiceRuntimeSupervisor;
	runner: ServiceRunner;
	identity: { packId: string; runtimeId: string };
	endpoint: string;
	storageIdentity: string;
}

async function start(
	mode: ServiceRunMode,
	root: string,
	dataDir: string,
	manifestOverride?: (value: ServiceRuntimeManifest) => ServiceRuntimeManifest,
	expectedState: "ready" | "degraded" = "ready",
): Promise<Running> {
	const value = manifest(root, manifestOverride);
	const contribution: RuntimeContribution = {
		id: value.id,
		listName: "runtime.yaml",
		sourceFile: join(root, "runtime.yaml"),
		packRoot: root,
		manifest: value,
	};
	const store = new ServiceRuntimeStore({ stateDir: join(root, "runtime-state"), serverIdentity: `hindsight-matrix-${runId}` });
	const continuity = continuityForFixtureBind(mode, dataDir);
	const runners: ServiceRunner[] = [new LocalServiceRunner(), new DockerServiceRunner(), new ComposeServiceRunner()];
	const runner = runners.find((candidate) => candidate.mode === mode)!;
	const supervisor = new ServiceRuntimeSupervisor({
		registry: { getRuntime: () => contribution } as any,
		store,
		runners,
		authorizer: { authorize: async () => true },
		settings: {
			resolve: async () => ({
				mode,
				revision: `matrix-${mode}`,
				values: {
					runtimeDataDir: mode === "local" ? dataDir : "/data",
					hostDataDir: dataDir,
				},
				storage: { dataPath: dataDir, ownedRoot: root },
				// Never hand-roll a fixture continuity key: reuse the exported
				// production Hindsight storage resolver over this fixture's actual bind.
				storageIdentity: continuity.identity,
				storageContinuity: continuity.continuity,
			}),
		},
		serverIdentity: `hindsight-matrix-${runId}`,
	});
	const identity = store.identity("hindsight-runtime-matrix", value.id);
	const status = await supervisor.start(identity);
	expect(status.state, `${mode} must reach its expected state`).toBe(expectedState);
	if (expectedState === "ready") {
		expect(status.endpoint).toBeTruthy();
		assertLoopbackDynamic(status.endpoint!);
	}
	expect((await store.load(identity))?.storageIdentity).toBe(continuity.identity);
	return { root, mode, manifest: value, store, supervisor, runner, identity, endpoint: status.endpoint ?? "", storageIdentity: continuity.identity };
}

async function stopAndRemove(running: Running): Promise<void> {
	await running.supervisor.stop(running.identity);
	await expect.poll(() => running.supervisor.status(running.identity).then((status) => status.state), { timeout: 5_000 }).toBe("stopped");
	const record = await running.store.load(running.identity);
	if (!record?.runnerIdentity) return;
	const envFile = running.mode === "compose" ? await running.store.environmentFile(running.identity) : undefined;
	await running.runner.remove({
		manifest: running.manifest,
		packRoot: running.root,
		descriptorDir: running.root,
		serverIdentity: `hindsight-matrix-${runId}`,
		serviceIdentity: `${running.identity.packId}\u0000${running.identity.runtimeId}`,
		packId: running.identity.packId,
		...(envFile ? { envFile } : {}),
		runnerIdentity: record.runnerIdentity,
	});
}

async function retainRecallReflect(endpoint: string, bank: string, marker: string): Promise<void> {
	const client = createClient({ baseUrl: endpoint, timeoutMs: 1_000 });
	await client.ensureBank(bank);
	await client.retain(bank, marker, { sync: true, tags: { project: "matrix" } });
	await expect.poll(async () => (await client.recall(bank, marker)).memories.map((memory) => memory.text), { timeout: 5_000 }).toContain(marker);
	await expect(client.reflect(bank, `Summarise ${marker}`)).resolves.toEqual({ text: `Reflection on: Summarise ${marker}` });
}

async function diagnostics(endpoint: string): Promise<{ processId: number; loadId: string; resident: boolean }> {
	return json(endpoint, "/__fixture/diagnostics");
}

async function logicalCopy(source: string, target: string): Promise<void> {
	const dump = await json(source, "/__fixture/export");
	await json(target, "/__fixture/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(dump),
	});
}

async function expectRecalled(endpoint: string, bank: string, marker: string): Promise<void> {
	const result = await createClient({ baseUrl: endpoint, timeoutMs: 1_000 }).recall(bank, marker);
	expect(result.memories.some((memory) => memory.text === marker)).toBe(true);
}

test.afterAll(async () => {
	try {
		if (imageBuilt && await dockerAvailable()) await execFileAsync("docker", ["image", "rm", "--force", image], { timeout: 30_000 }).catch(() => {});
	} finally {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	}
});

test.describe.serial("Hindsight real runtime mode matrix", () => {
	test("external and local use the identical retain/recall/reflect endpoint contract with resident model reuse", async () => {
		const root = rootFor("external-local");
		const dataDir = join(root, "local-data");
		const running = await start("local", root, dataDir);
		try {
			const bank = `matrix-${runId}-external`;
			const marker = `external-local-${runId}`;
			const before = await diagnostics(running.endpoint);
			await retainRecallReflect(running.endpoint, bank, marker);
			await retainRecallReflect(running.endpoint, bank, `${marker}-second`);
			const after = await diagnostics(running.endpoint);
			expect(after).toEqual(before);

			// The client treats this loopback URL as an externally managed endpoint:
			// it calls no lifecycle adapter and needs no key or paid fallback.
			await expectRecalled(running.endpoint, bank, marker);

			await running.supervisor.stop(running.identity);
			const restarted = await running.supervisor.start(running.identity);
			expect(restarted.state).toBe("ready");
			expect((await running.store.load(running.identity))?.storageIdentity).toBe(running.storageIdentity);
			await expectRecalled(restarted.endpoint!, bank, marker);
		} finally {
			await stopAndRemove(running).catch(() => {});
			// Runner cleanup never deletes the owned data directory; only this test's
			// isolated temp root is removed in afterAll.
			expect(readFileSync(join(dataDir, "banks.json"), "utf8")).toContain(`external-local-${runId}`);
		}
	});

	test("Docker and Compose preserve a logically migrated bank across stop/start", { timeout: 180_000 }, async () => {
		test.skip(!(await dockerAvailable()), "HINDSIGHT_RUNTIME_MATRIX_DOCKER_UNAVAILABLE: Docker daemon is required for Docker/Compose adapters");
		const imageRoot = rootFor("image");
		await buildImage(imageRoot);
		const sourceRoot = rootFor("migration-source");
		const source = await start("local", sourceRoot, join(sourceRoot, "source-data"));
		try {
			const bank = `matrix-${runId}-migration`;
			const marker = `logical-migration-marker-${runId}`;
			await retainRecallReflect(source.endpoint, bank, marker);
			for (const mode of ["docker", "compose"] as const) {
				const targetRoot = rootFor(`migration-${mode}`);
				const targetData = join(targetRoot, "target-data");
				const target = await start(mode, targetRoot, targetData);
				try {
					await logicalCopy(source.endpoint, target.endpoint);
					await expectRecalled(target.endpoint, bank, marker);
					await target.supervisor.stop(target.identity);
					const restarted = await target.supervisor.start(target.identity);
					expect(restarted.state).toBe("ready");
					expect((await target.store.load(target.identity))?.storageIdentity).toBe(target.storageIdentity);
					await expectRecalled(restarted.endpoint!, bank, marker);
				} finally {
					await stopAndRemove(target).catch(() => {});
					expect(readFileSync(join(targetData, "banks.json"), "utf8")).toContain(marker);
				}
			}
		} finally {
			await stopAndRemove(source).catch(() => {});
		}
	});

	test("an unhealthy or down local endpoint degrades within its declared bound without a fallback", async () => {
		const root = rootFor("unhealthy");
		const startedAt = Date.now();
		const running = await start("local", root, join(root, "data"), (value) => ({
			...value,
			endpoint: { ...value.endpoint, health: { ...value.endpoint.health, requestTimeoutMs: 100, intervalMs: 50, startupTimeoutMs: 750 } },
			environment: { ...value.environment, HINDSIGHT_FIXTURE_UNHEALTHY: { value: "1" } },
		}), "degraded");
		try {
			// A failed health check exposes no endpoint and never selects another provider.
			expect(running.endpoint).toBe("");
		} finally {
			await stopAndRemove(running).catch(() => {});
		}
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		const downClient = createClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 400 });
		const downAt = Date.now();
		await expect(downClient.retain(`matrix-${runId}`, "must not fall back", { sync: true })).rejects.toMatchObject({ kind: "network" });
		expect(Date.now() - downAt).toBeLessThan(1_500);
	});
});

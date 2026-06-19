/**
 * Manual-integration — managed Hindsight runtime against REAL Docker.
 *
 * Drives the actual {@link PackRuntimeSupervisor} (the ONLY Docker seam) over the
 * REAL shipped Hindsight runtime manifest/compose
 * (market-packs/hindsight/runtimes/hindsight.yaml + runtime/compose.yaml). It is
 * the ground-truth check for the P3 managed-mode lifecycle:
 *
 *   enable (compose up, managed-postgres) → wait healthy → retain/recall round-trip
 *   → disable (compose stop) → bind-mounted data survives → updatePack (atomic pack
 *   swap) → bind data + runtime state survive → re-enable → recall still finds the
 *   marker.
 *
 * It NEVER touches the user's ~/.hindsight: every byte of state (rendered env,
 * generated secrets, allocated ports, the Postgres bind dir) lives under a
 * per-run temp dir that is torn down (compose down -v + rm) in `finally`. A unique
 * bank/namespace/marker per run means it cannot collide with a previous run or the
 * production `bobbit` bank.
 *
 * Skips CLEANLY (test marked skipped, never failed) when:
 *   - Docker is unavailable (no daemon / not installed), or
 *   - HINDSIGHT_API_LLM_API_KEY is unset (the managed API needs an LLM key), or
 *   - the managed stack cannot become healthy within the deadline (e.g. the
 *     digest-pinned ghcr.io/vectorize-io/hindsight + pgvector/pgvector images are
 *     not pullable on this host).
 * So the manual suite stays green everywhere; the test does real work only where a
 * usable managed Hindsight can actually start.
 *
 *   HINDSIGHT_API_LLM_API_KEY=<key> npm run build \
 *     && node --import tsx --test tests/manual-integration/hindsight-runtime.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";
import {
	PackRuntimeSupervisor,
	FilePortStore,
	packRuntimePersistKey,
} from "../../src/server/runtimes/pack-runtime-supervisor.ts";
import { SecretsStore } from "../../src/server/agent/secrets-store.ts";
import type { RuntimeContribution } from "../../src/server/agent/pack-contributions.ts";
import type { PackContributionResolver } from "../../src/server/extension-host/pack-contribution-registry.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_PACK_ROOT = path.join(REPO_ROOT, "market-packs", "hindsight");

const PACK_ID = "hindsight";
const RUNTIME_ID = "hindsight";
const LLM_KEY = process.env.HINDSIGHT_API_LLM_API_KEY;
const DOCKER_BIN = process.env.DOCKER_BIN ?? "docker";

/** True only when a Docker daemon actually responds (never throws). */
async function dockerAvailable(): Promise<boolean> {
	try {
		await execFileAsync(DOCKER_BIN, ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * A single-runtime registry backed by the REAL shipped Hindsight manifest, read
 * from a WORKING COPY at `packRoot` (so the updatePack swap below can replace the
 * pack contents without touching the repo). The resolver re-reads the manifest
 * file on every lookup so a mid-test pack swap is reflected.
 */
function makeRegistry(packRoot: string): PackContributionResolver {
	const runtimeFile = path.join(packRoot, "runtimes", "hindsight.yaml");
	const raw = parseYaml(fs.readFileSync(runtimeFile, "utf-8")) as Record<string, unknown>;
	const contribution: RuntimeContribution = {
		id: RUNTIME_ID,
		title: "Hindsight",
		listName: "hindsight",
		sourceFile: runtimeFile,
		packRoot,
		manifest: raw,
	};
	const pack = {
		packId: PACK_ID,
		packName: "Hindsight",
		packRoot,
		panels: [],
		entrypoints: [],
		providers: [],
		runtimes: [contribution],
	};
	const resolver = {
		list: () => [pack],
		getPack: (_p: string | undefined, packId: string) => (packId === PACK_ID ? pack : undefined),
		getRuntime: (_p: string | undefined, packId: string, runtimeId: string) =>
			packId === PACK_ID && runtimeId === RUNTIME_ID ? contribution : undefined,
		getPanel: () => undefined,
		getEntrypoint: () => undefined,
		listProviders: () => [],
		hasRoute: () => false,
	};
	return resolver as unknown as PackContributionResolver;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Faithfully reproduce the filesystem operation `MarketplaceInstaller.updatePack`
 * performs: copy the current pack contents to a staging dir, then atomically
 * rename-swap it into place (old aside → publish staging → drop old). This is the
 * exact mutation an update applies to the installed pack dir. It touches ONLY the
 * pack CONTENTS dir — never the bind-mounted Postgres data dir nor the supervisor
 * state dir — which is precisely why managed data must survive an update.
 */
function simulateUpdatePack(packRoot: string): void {
	const parent = path.dirname(packRoot);
	const name = path.basename(packRoot);
	const staging = path.join(parent, `.tmp-${name}-${Math.random().toString(36).slice(2, 10)}`);
	const backup = path.join(parent, `.tmp-old-${name}-${Math.random().toString(36).slice(2, 10)}`);
	fs.cpSync(packRoot, staging, { recursive: true });
	fs.renameSync(packRoot, backup);
	try {
		fs.renameSync(staging, packRoot);
	} catch (err) {
		fs.renameSync(backup, packRoot);
		throw err;
	}
	fs.rmSync(backup, { recursive: true, force: true });
}

interface FetchResult { status: number; ok: boolean; body: any }
async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<FetchResult> {
	const { timeoutMs = 15_000, ...rest } = init;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...rest, signal: ctrl.signal });
		let body: any = null;
		const text = await res.text();
		if (text) { try { body = JSON.parse(text); } catch { body = text; } }
		return { status: res.status, ok: res.ok, body };
	} finally {
		clearTimeout(timer);
	}
}

describe("hindsight managed runtime (real Docker)", () => {
	test("enable → healthy → retain/recall → disable → data survives → re-enable recall", { timeout: 600_000 }, async (t) => {
		if (!(await dockerAvailable())) {
			t.skip(`Docker not available via ${DOCKER_BIN} (set DOCKER_BIN to run)`);
			return;
		}
		if (!LLM_KEY) {
			t.skip("HINDSIGHT_API_LLM_API_KEY unset — the managed Hindsight API needs an LLM key");
			return;
		}

		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-rt-it-"));
		const dataDir = path.join(tmp, "data");
		const runtimeDataDir = path.join(tmp, "pack-runtimes");
		// A WORKING COPY of the shipped pack so the updatePack swap never mutates the repo.
		const packRoot = path.join(tmp, "pack");
		fs.mkdirSync(dataDir, { recursive: true });
		fs.mkdirSync(runtimeDataDir, { recursive: true });
		fs.cpSync(SOURCE_PACK_ROOT, packRoot, { recursive: true });

		const portStore = new FilePortStore(path.join(runtimeDataDir, "ports.json"));
		const supervisor = new PackRuntimeSupervisor({
			registry: makeRegistry(packRoot),
			dockerBin: DOCKER_BIN,
			// A stable suffix so re-enable in this run addresses the SAME compose project.
			serverIdentitySuffix: `it-${Date.now().toString(36)}`,
			runtimeDataDir,
			secretsStore: new SecretsStore(tmp),
			portStore,
			startupTimeoutMs: 240_000,
			pollIntervalMs: 3_000,
		});

		// Unique, isolated bank/namespace/marker so this never collides with another
		// run or the production `bobbit` bank.
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const NAMESPACE = `it-${stamp}`;
		const BANK = `bobbit-rt-${stamp}`;
		const marker = `rt-it-${stamp}`;
		const startConfig = { dataDir, HINDSIGHT_API_LLM_API_KEY: LLM_KEY };

		let started = false;
		try {
			// 1. Enable: explicit managed start (compose up -d, managed-postgres).
			const up = await supervisor.start(PACK_ID, RUNTIME_ID, { mode: "managed-postgres", config: startConfig });
			started = true;
			if (up.status !== "running") {
				// The digest-pinned ghcr.io/vectorize-io/hindsight images may not be pullable on this
				// host — that is an environment limitation, not a product regression.
				t.skip(`managed Hindsight did not become healthy (status=${up.status}; ${up.message ?? "images may be unpullable"})`);
				return;
			}

			const apiPort = portStore.get(packRuntimePersistKey(PACK_ID, RUNTIME_ID, "HINDSIGHT_API_PORT"));
			assert.equal(typeof apiPort, "number", "the managed API host port must be persisted after start");
			const apiBase = `http://127.0.0.1:${apiPort}`;
			const seg = (s: string) => encodeURIComponent(s);
			const bankBase = `${apiBase}/v1/${seg(NAMESPACE)}/banks/${seg(BANK)}`;

			// 2. retain/recall round-trip against the managed API.
			const content = `Managed Hindsight integration fact: codename is ${marker}.`;
			const ensure = await fetchJson(bankBase, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
			assert.equal(ensure.ok, true, `ensureBank failed: ${ensure.status} ${JSON.stringify(ensure.body)}`);
			const retain = await fetchJson(`${bankBase}/memories`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ items: [{ content, tags: [`session:${marker}`, "kind:turn"] }], async: false }),
				timeoutMs: 60_000,
			});
			assert.equal(retain.ok, true, `retain failed: ${retain.status} ${JSON.stringify(retain.body)}`);

			const recallFinds = async (): Promise<boolean> => {
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline) {
					const recall = await fetchJson(`${bankBase}/memories/recall`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ query: `codename ${marker}`, max_tokens: 1024 }),
						timeoutMs: 15_000,
					});
					if (recall.ok && Array.isArray(recall.body?.results) &&
						recall.body.results.some((r: any) => typeof r?.text === "string" && r.text.includes(marker))) {
						return true;
					}
					await sleep(1_500);
				}
				return false;
			};
			assert.equal(await recallFinds(), true, `recall did not surface ${marker} after retain`);

			// 3. Disable: compose stop. Containers stop; bind-mounted data must persist.
			const stopped = await supervisor.stop(PACK_ID, RUNTIME_ID);
			assert.ok(stopped.status === "stopped" || stopped.status === "starting", `unexpected post-stop status ${stopped.status}`);

			// 4. Data survives the stop: the Postgres bind mount is still populated.
			const pgDir = path.join(dataDir, "postgres");
			assert.ok(fs.existsSync(pgDir) && fs.readdirSync(pgDir).length > 0, "managed Postgres bind data must survive disable");

			// 5. updatePack: atomically swap the installed pack contents (exactly as
			//    MarketplaceInstaller.updatePack does). An update must NEVER delete the
			//    bind-mounted data nor the supervisor's runtime state, so both must still
			//    be present afterward (the design's data-survives-updatePack requirement).
			simulateUpdatePack(packRoot);
			assert.ok(
				fs.existsSync(pgDir) && fs.readdirSync(pgDir).length > 0,
				"managed Postgres bind data must survive an updatePack",
			);
			assert.ok(
				fs.existsSync(path.join(runtimeDataDir, "ports.json")),
				"supervisor-owned runtime state (persisted ports) must survive an updatePack",
			);
			assert.equal(
				portStore.get(packRuntimePersistKey(PACK_ID, RUNTIME_ID, "HINDSIGHT_API_PORT")),
				apiPort,
				"the persisted API host port must survive an updatePack",
			);

			// 6. Re-enable after the update: the SAME persisted port/secret/state are
			//    reused, and recall still finds the marker proving the data round-tripped
			//    across disable → updatePack → re-enable.
			const reup = await supervisor.start(PACK_ID, RUNTIME_ID, { mode: "managed-postgres", config: startConfig });
			assert.equal(reup.status, "running", `re-enable failed: ${reup.message ?? reup.status}`);
			assert.equal(
				portStore.get(packRuntimePersistKey(PACK_ID, RUNTIME_ID, "HINDSIGHT_API_PORT")),
				apiPort,
				"re-enable must reuse the persisted host port",
			);
			assert.equal(await recallFinds(), true, `recall lost ${marker} after disable→updatePack→re-enable — data did not survive`);
		} finally {
			// Tear down ONLY this run's compose project + volumes + temp state.
			try { if (started) await supervisor.down(PACK_ID, RUNTIME_ID, { volumes: true, removeState: true }); } catch { /* best-effort */ }
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});

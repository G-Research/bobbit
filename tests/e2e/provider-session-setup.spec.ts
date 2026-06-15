import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The provider-demo fixture is installed as a SERVER-SCOPE market pack into the
// per-worker gateway dir — NOT via BOBBIT_BUILTIN_PACKS_DIR. The in-process
// gateway is worker-scoped (one gateway shared by every spec in a Playwright
// worker) and resolves the built-in packs dir from the global process.env, so
// mutating BOBBIT_BUILTIN_PACKS_DIR would replace the real built-in band for
// the whole worker and break sibling specs (pr-walkthrough, marketplace, …).
// Installing the fixture as a market pack layers it ON TOP of the real built-in
// band — listProviders enumerates installed market packs additively — so no
// built-in pack is removed and the fixture is still discovered.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturePackDir = path.resolve(__dirname, "..", "fixtures", "packs", "provider-demo");
const PACK_NAME = "provider-demo";

function writeMeta(packDir: string): void {
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${PACK_NAME}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n", "utf-8");
}

// Copy the source-of-truth fixture pack (pack.yaml + providers/ + lib/) into the
// per-gateway server-scope market-packs dir, preserving subdir structure.
function installPack(bobbitDir: string): string {
	const packDir = path.join(bobbitDir, ".bobbit", "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(fixturePackDir, packDir, { recursive: true });
	writeMeta(packDir);
	return packDir;
}

async function dynamicContextSection(sessionId: string): Promise<any | undefined> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return body.sections.find((section: any) => section.label === "Dynamic Context");
}

async function setProviderDisabled(providers: string[]): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({
			scope: "server",
			packName: PACK_NAME,
			disabled: { providers },
		}),
	});
	expect(resp.status).toBe(200);
}

test.describe("sessionSetup provider dynamic context", () => {
	const sessions: string[] = [];
	const cwds: string[] = [];
	let packDir: string;

	test.beforeAll(async ({ gateway }) => {
		packDir = installPack(gateway.bobbitDir);
		// Enable all providers + trigger a resolver-cache invalidation so the
		// worker-scoped gateway (whose registry cache may already be built by an
		// earlier spec) picks up the freshly-installed pack.
		await setProviderDisabled([]);
	});

	test.afterAll(async () => {
		// Reset activation and remove the per-gateway pack dir so the worker is
		// left clean for any later spec sharing this gateway.
		await setProviderDisabled([]).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
	});

	test.afterEach(async () => {
		await setProviderDisabled(["demo", "boom"]).catch(() => {});
		for (const sessionId of sessions.splice(0)) {
			await deleteSession(sessionId).catch(() => {});
		}
		for (const cwd of cwds.splice(0)) {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("sessionSetup blocks appear in prompt sections and provider failures do not block spawn", async () => {
		await setProviderDisabled([]);

		const happyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "provider-demo-happy-"));
		cwds.push(happyCwd);
		const happySession = await createSession({ cwd: happyCwd });
		sessions.push(happySession);

		const happySection = await dynamicContextSection(happySession);
		expect(happySection).toBeTruthy();
		expect(happySection.source).toBe("providers");
		expect(happySection.content).toContain(`DEMO_SETUP_BLOCK ${happySession}`);

		const logPath = path.join(happyCwd, ".provider-demo-log");
		expect(fs.existsSync(logPath)).toBe(true);
		const logLines = fs.readFileSync(logPath, "utf-8").trim().split(/\r?\n/).filter(Boolean);
		expect(logLines).toEqual(["sessionSetup"]);

		// Disable the block-producing provider. The throwing boom provider remains enabled:
		// this session still spawns, and because boom returns no blocks, no Dynamic Context
		// section is produced.
		await setProviderDisabled(["demo"]);
		const boomOnlyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "provider-demo-boom-"));
		cwds.push(boomOnlyCwd);
		const boomOnlySession = await createSession({ cwd: boomOnlyCwd });
		sessions.push(boomOnlySession);

		const boomOnlySection = await dynamicContextSection(boomOnlySession);
		expect(boomOnlySection).toBeUndefined();
		expect(fs.existsSync(path.join(boomOnlyCwd, ".provider-demo-log"))).toBe(false);
	});
});

import { test, expect } from "../in-process-harness.js";
import { apiFetch, createSession, deleteSession, nonGitCwd } from "../e2e-setup.js";
import {
	installProviderDemoFixture,
	type ProviderDemoFixture,
} from "../test-utils/provider-demo-marketplace.js";

// The provider-demo fixture is installed as a SERVER-SCOPE market pack into the
// per-worker gateway dir — NOT via BOBBIT_BUILTIN_PACKS_DIR. The in-process
// gateway is worker-scoped (one gateway shared by every spec in a Playwright
// worker) and resolves the built-in packs dir from the global process.env, so
// mutating BOBBIT_BUILTIN_PACKS_DIR would replace the real built-in band for
// the whole worker and break sibling specs (pr-walkthrough, marketplace, …).
// Installing the fixture as a market pack layers it ON TOP of the real built-in
// band — listProviders enumerates installed market packs additively — so no
// built-in pack is removed and the fixture is still discovered.
import fs from "node:fs";
import path from "node:path";

async function dynamicContextSection(sessionId: string): Promise<any | undefined> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return body.sections.find((section: any) => section.label === "Dynamic Context");
}

test.describe("sessionSetup provider dynamic context", () => {
	const sessions: string[] = [];
	const cwds: string[] = [];
	let providerFixture: ProviderDemoFixture | undefined;

	test.beforeAll(async () => {
		providerFixture = await installProviderDemoFixture([]);
	});

	test.afterAll(async () => {
		if (providerFixture) await providerFixture.dispose();
	});

	test.afterEach(async () => {
		const cleanupErrors: unknown[] = [];
		const fixture = providerFixture;
		const stages: Array<() => Promise<void>> = [
			// Keep provider hooks quiet before deleting sessions.
			...(fixture ? [() => fixture.setDisabled(["demo", "boom", "slow"])] : []),
			...sessions.splice(0).map((sessionId) => () => deleteSession(sessionId)),
			...cwds.splice(0).map((cwd) => async () => { fs.rmSync(cwd, { recursive: true, force: true }); }),
		];
		for (const stage of stages) {
			try { await stage(); } catch (error) { cleanupErrors.push(error); }
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "provider session-setup fixture cleanup failed");
	});

	test("sessionSetup blocks appear in prompt sections and provider failures do not block spawn", async () => {
		await providerFixture!.setDisabled([]);

		const happyCwd = fs.mkdtempSync(path.join(nonGitCwd(), "provider-demo-happy-"));
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
		await providerFixture!.setDisabled(["demo"]);
		const boomOnlyCwd = fs.mkdtempSync(path.join(nonGitCwd(), "provider-demo-boom-"));
		cwds.push(boomOnlyCwd);
		const boomOnlySession = await createSession({ cwd: boomOnlyCwd });
		sessions.push(boomOnlySession);

		const boomOnlySection = await dynamicContextSection(boomOnlySession);
		expect(boomOnlySection).toBeUndefined();
		expect(fs.existsSync(path.join(boomOnlyCwd, ".provider-demo-log"))).toBe(false);
	});
});

import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturePacksDir = path.resolve(__dirname, "..", "fixtures", "packs");
const previousBuiltinPacksDir = process.env.BOBBIT_BUILTIN_PACKS_DIR;
process.env.BOBBIT_BUILTIN_PACKS_DIR = fixturePacksDir;

test.afterAll(async ({ gateway }) => {
	if (previousBuiltinPacksDir === undefined) delete process.env.BOBBIT_BUILTIN_PACKS_DIR;
	else process.env.BOBBIT_BUILTIN_PACKS_DIR = previousBuiltinPacksDir;
	try { (gateway.sessionManager.lifecycleHub as any)?.registry?.invalidate?.(); } catch { /* best-effort depollution */ }
});

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
			packName: "provider-demo",
			disabled: { providers },
		}),
	});
	expect(resp.status).toBe(200);
}

test.describe("sessionSetup provider dynamic context", () => {
	const sessions: string[] = [];
	const cwds: string[] = [];

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

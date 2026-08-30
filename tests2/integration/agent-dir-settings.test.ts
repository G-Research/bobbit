import { test, expect } from "./_e2e/in-process-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeAgentDirRuntime, resetAgentDirRuntimeForTests } from "../../src/server/agent-dir-config.js";
import { apiFetch, bobbitDir } from "./_e2e/e2e-setup.js";

test.describe.configure({ mode: "serial" });

type AgentDirState = Record<string, any>;

function normalize(p: string): string {
	return path.normalize(p);
}

function activePath(state: AgentDirState): string {
	return state.activePath ?? state.active?.path ?? state.startup?.dir ?? state.startup?.path;
}

function activeSource(state: AgentDirState): string {
	return state.activeSource ?? state.active?.source ?? state.startup?.source;
}

function pendingPath(state: AgentDirState): string | undefined {
	return state.pendingPath ?? state.pending?.path ?? state.persistedPath ?? state.persisted;
}

function nextStartPath(state: AgentDirState): string {
	const next = state.nextStart;
	return state.nextStartPath ?? next?.path ?? next?.dir;
}

function errorCode(body: any): string | undefined {
	return body?.error?.code ?? body?.code;
}

async function json(resp: Response): Promise<any> {
	const body = await resp.text();
	try {
		return body ? JSON.parse(body) : null;
	} catch {
		throw new Error(`Expected JSON response, got ${resp.status}: ${body}`);
	}
}

async function expectOkJson(resp: Response): Promise<any> {
	const body = await json(resp);
	expect(resp.ok, JSON.stringify(body)).toBe(true);
	return body;
}

interface PathSnapshot {
	target: string;
	backup?: string;
}

function snapshotPath(target: string, backupRoot: string, index: number): PathSnapshot {
	if (!fs.existsSync(target)) return { target };
	const backup = path.join(backupRoot, String(index));
	fs.cpSync(target, backup, { recursive: true, force: true });
	return { target, backup };
}

function restorePath(snapshot: PathSnapshot): void {
	fs.rmSync(snapshot.target, { recursive: true, force: true });
	if (!snapshot.backup) return;
	fs.mkdirSync(path.dirname(snapshot.target), { recursive: true });
	fs.cpSync(snapshot.backup, snapshot.target, { recursive: true, force: true });
}

function restorePreferences(
	gateway: any,
	initial: Record<string, unknown>,
	initialAgentDirState: AgentDirState,
	preferencesPath: string,
	preferencesBytes: Buffer | undefined,
): void {
	const store = gateway.sessionManager?.preferencesStore;
	if (!store) throw new Error("gateway fixture must expose its PreferencesStore for test cleanup");
	for (const key of Object.keys(store.getAll())) {
		if (!Object.prototype.hasOwnProperty.call(initial, key)) store.remove(key);
	}
	for (const [key, value] of Object.entries(initial)) store.set(key, structuredClone(value));

	// The pending route also mutates the process-wide agent-dir runtime. Rebuild it
	// from the original persisted preference after restoring the store in memory.
	resetAgentDirRuntimeForTests();
	initializeAgentDirRuntime({
		env: process.env,
		projectRoot: initialAgentDirState.startup.projectRoot,
		stateDir: path.dirname(preferencesPath),
		persisted: typeof initial.agentDir === "string" ? initial.agentDir : undefined,
	});

	// PreferencesStore and runtime restoration serialize JSON. Put back the exact
	// original bytes last so this integration test is transparent to later files.
	if (preferencesBytes === undefined) fs.rmSync(preferencesPath, { force: true });
	else fs.writeFileSync(preferencesPath, preferencesBytes);
}

test("agent-dir REST flow validates, saves restart-gated pending state, and migrates by copy", async ({ gateway }) => {
	const initial = await expectOkJson(await apiFetch("/api/agent-dir"));
	const active = activePath(initial);
	expect(active, JSON.stringify(initial)).toBeTruthy();
	expect(normalize(active)).toBe(normalize(path.join(bobbitDir(), "agent")));
	expect(activeSource(initial)).toBe("BOBBIT_AGENT_DIR");
	expect(initial.defaultPath ?? initial.default?.path ?? initial.defaultDir).toBeTruthy();
	expect(initial.history ?? initial.agentDirHistory ?? []).toEqual(expect.arrayContaining([expect.any(String)]));

	const preferencesPath = path.join(bobbitDir(), "state", "preferences.json");
	const preferencesBytes = fs.existsSync(preferencesPath) ? fs.readFileSync(preferencesPath) : undefined;
	const preferencesStore = (gateway.sessionManager as any)?.preferencesStore;
	expect(preferencesStore, "gateway fixture must expose its PreferencesStore for test cleanup").toBeTruthy();
	const initialPreferences = structuredClone(preferencesStore.getAll()) as Record<string, unknown>;
	const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-agent-dir-settings-"));
	const sessionsDir = path.join(active, "sessions");
	const sessionsDirExisted = fs.existsSync(sessionsDir);
	const activeSnapshots = [
		path.join(active, "sessions", "session-a"),
		path.join(active, "bin"),
		...[
			"auth.json",
			"models.json",
			"settings.json",
			"google-code-assist.json",
			"not-allowlisted.txt",
		].map((file) => path.join(active, file)),
	].map((target, index) => snapshotPath(target, backupRoot, index));
	const unique = `${process.pid}-${Date.now()}`;
	const bypassPath = path.join(path.dirname(bobbitDir()), `bypass-agent-dir-${unique}`);
	const pending = path.join(path.dirname(bobbitDir()), `pending-agent-dir-${unique}`);
	fs.rmSync(bypassPath, { recursive: true, force: true });
	fs.rmSync(pending, { recursive: true, force: true });

	try {
		const invalid = await json(await apiFetch("/api/agent-dir/validate", {
			method: "POST",
			body: JSON.stringify({ path: "src/agent-dir-credentials" }),
		}));
		expect(invalid.ok).toBe(false);
		expect(errorCode(invalid)).toBe("INSIDE_WORKTREE");

		const bypassResp = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ agentDir: bypassPath, agentDirHistory: [bypassPath] }),
		});
		const bypass = await json(bypassResp);
		expect(bypassResp.status).toBe(400);
		const bypassPrefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8")) : {};
		const safePref = await expectOkJson(await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ showHeadquartersInProjectLists: true }),
		}));
		expect(safePref.showHeadquartersInProjectLists).toBe(true);
		expect(String(bypass.error ?? bypass.message)).toMatch(/agentDir|agent directory|agent-dir\/pending/i);
		expect(bypass.code).toBe("AGENT_DIR_PREFERENCE_FORBIDDEN");
		expect(bypassPrefs.agentDir).toEqual(initialPreferences.agentDir);
		expect((bypassPrefs.agentDirHistory ?? []).map(normalize)).not.toContain(normalize(bypassPath));

		const valid = await expectOkJson(await apiFetch("/api/agent-dir/validate", {
			method: "POST",
			body: JSON.stringify({ path: pending }),
		}));
		expect(valid.ok).toBe(true);
		expect(normalize(valid.resolvedPath)).toBe(normalize(pending));
		expect(fs.statSync(pending).isDirectory()).toBe(true);

		const saved = await expectOkJson(await apiFetch("/api/agent-dir/pending", {
			method: "PUT",
			body: JSON.stringify({ path: pending }),
		}));
		expect(normalize(activePath(saved))).toBe(normalize(active));
		expect(normalize(pendingPath(saved)!)).toBe(normalize(pending));
		expect(normalize(nextStartPath(saved))).toBe(normalize(active));
		expect(saved.restartRequired).toBe(false);
		expect(saved.envOverride ?? saved.envOverrideActive).toBeTruthy();
		expect(String(saved.restartGuidance ?? saved.guidance ?? saved.message)).toMatch(/restart|env/i);

		const prefs = JSON.parse(fs.readFileSync(path.join(bobbitDir(), "state", "preferences.json"), "utf-8"));
		expect(normalize(prefs.agentDir)).toBe(normalize(pending));
		expect((prefs.agentDirHistory ?? []).map(normalize)).toEqual(expect.arrayContaining([normalize(active), normalize(pending)]));

		fs.mkdirSync(path.join(active, "sessions", "session-a"), { recursive: true });
		fs.mkdirSync(path.join(active, "bin"), { recursive: true });
		fs.writeFileSync(path.join(active, "sessions", "session-a", "transcript.jsonl"), "source transcript\n");
		fs.writeFileSync(path.join(active, "bin", "rg"), "source rg");
		for (const file of ["auth.json", "models.json", "settings.json", "google-code-assist.json"]) {
			fs.writeFileSync(path.join(active, file), `${file} source`);
		}
		fs.writeFileSync(path.join(active, "not-allowlisted.txt"), "do not copy");

		const migrated = await expectOkJson(await apiFetch("/api/agent-dir/migrate", {
			method: "POST",
			body: JSON.stringify({ sourcePath: active, destinationPath: pending, overwrite: false }),
		}));
		expect(fs.existsSync(active)).toBe(true);
		expect(fs.readFileSync(path.join(active, "auth.json"), "utf-8")).toBe("auth.json source");
		expect(fs.readFileSync(path.join(pending, "sessions", "session-a", "transcript.jsonl"), "utf-8")).toBe("source transcript\n");
		expect(fs.readFileSync(path.join(pending, "bin", "rg"), "utf-8")).toBe("source rg");
		expect(fs.existsSync(path.join(pending, "not-allowlisted.txt"))).toBe(false);
		expect(JSON.stringify(migrated)).toMatch(/copied|sessions|auth\.json|models\.json|settings\.json|google-code-assist\.json|bin/);

		fs.writeFileSync(path.join(pending, "auth.json"), "existing auth");
		const skipped = await expectOkJson(await apiFetch("/api/agent-dir/migrate", {
			method: "POST",
			body: JSON.stringify({ sourcePath: active, destinationPath: pending, overwrite: false }),
		}));
		expect(fs.readFileSync(path.join(pending, "auth.json"), "utf-8")).toBe("existing auth");
		expect(JSON.stringify(skipped.skipped ?? skipped)).toMatch(/auth\.json/);

		const overwritten = await expectOkJson(await apiFetch("/api/agent-dir/migrate", {
			method: "POST",
			body: JSON.stringify({ sourcePath: active, destinationPath: pending, overwrite: true }),
		}));
		expect(fs.readFileSync(path.join(pending, "auth.json"), "utf-8")).toBe("auth.json source");
		expect(JSON.stringify(overwritten.overwritten ?? overwritten)).toMatch(/auth\.json/);

		const reloaded = await expectOkJson(await apiFetch("/api/agent-dir"));
		expect(normalize(activePath(reloaded))).toBe(normalize(active));
		expect(normalize(pendingPath(reloaded)!)).toBe(normalize(pending));
	} finally {
		const cleanupErrors: unknown[] = [];
		const cleanup = (fn: () => void): void => {
			try { fn(); } catch (error) { cleanupErrors.push(error); }
		};
		cleanup(() => fs.rmSync(pending, { recursive: true, force: true }));
		cleanup(() => fs.rmSync(bypassPath, { recursive: true, force: true }));
		for (const snapshot of [...activeSnapshots].reverse()) cleanup(() => restorePath(snapshot));
		if (!sessionsDirExisted) cleanup(() => fs.rmdirSync(sessionsDir));
		cleanup(() => restorePreferences(gateway, initialPreferences, initial, preferencesPath, preferencesBytes));
		cleanup(() => fs.rmSync(backupRoot, { recursive: true, force: true }));
		if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Failed to restore agent-dir integration fixture");
	}
});

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { apiFetch, bobbitDir } from "./e2e-setup";

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

test("agent-dir REST flow validates, saves restart-gated pending state, and migrates by copy", async () => {
	const initial = await expectOkJson(await apiFetch("/api/agent-dir"));
	const active = activePath(initial);
	expect(active, JSON.stringify(initial)).toBeTruthy();
	expect(normalize(active)).toBe(normalize(path.join(bobbitDir(), "agent")));
	expect(activeSource(initial)).toBe("BOBBIT_AGENT_DIR");
	expect(initial.defaultPath ?? initial.default?.path ?? initial.defaultDir).toBeTruthy();
	expect(initial.history ?? initial.agentDirHistory ?? []).toEqual(expect.arrayContaining([expect.any(String)]));

	const invalid = await json(await apiFetch("/api/agent-dir/validate", {
		method: "POST",
		body: JSON.stringify({ path: "src/agent-dir-credentials" }),
	}));
	expect(invalid.ok).toBe(false);
	expect(errorCode(invalid)).toBe("INSIDE_WORKTREE");

	const pending = path.join(bobbitDir(), "pending-agent-dir");
	fs.rmSync(pending, { recursive: true, force: true });
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
});

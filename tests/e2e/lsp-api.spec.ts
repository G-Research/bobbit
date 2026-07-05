/**
 * API E2E tests for the wave 1 `code_*` tool group's backing endpoints
 * (docs/design/lsp-product-tools.md): `GET /api/internal/lsp/{definition,
 * references,hover,symbols}` (src/server/routes/lsp-routes.ts).
 *
 * Auth-enforcement shape mirrors tests/e2e/orient-api.spec.ts (same
 * X-Bobbit-Session-Id contract). The "fail-open" cases (missing tsconfig,
 * sandboxed session) need no real `typescript-language-server` — they
 * short-circuit inside `TsServerSupervisor.prepare()`/the route itself before
 * ever spawning anything, so they run unconditionally.
 *
 * The happy-path suite spawns a REAL `typescript-language-server` process
 * (this is an in-process-gateway API E2E — the gateway runs in this same
 * Node process, but `TsServerSupervisor` still shells out to the real
 * binary). It's skipped when the binary isn't on PATH rather than failing,
 * since it isn't a repo devDependency (same assumption `scripts/lsp-cli.mjs`
 * and the `orient` skill already make — see docs/dev-workflow.md).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, createSession, deleteSession, defaultProject, defaultProjectId } from "./e2e-setup.js";

function hasTsLanguageServer(): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", ["typescript-language-server"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * A `createSession({ cwd })` cwd must resolve inside the target project's
 * rootPath (or an owned Bobbit worktree) — the gateway 422s
 * (`CWD_OUTSIDE_PROJECT`) on an arbitrary path like a bare OS tmpdir. Nest
 * fixture dirs under the default project's own rootPath instead.
 */
async function makeFixtureDirUnderProject(prefix: string): Promise<string> {
	const project = await defaultProject();
	const dir = join(project.rootPath, ".e2e-lsp-fixtures", `${prefix}-${randomUUID()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function makeFixtureProject(): Promise<{ dir: string; targetFile: string }> {
	const dir = await makeFixtureDirUnderProject("project");
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "commonjs", target: "es2020", strict: false } }));
	writeFileSync(join(dir, "lib.ts"), 'export function greet(name: string): string {\n\treturn `hello ${name}`;\n}\n');
	writeFileSync(join(dir, "main.ts"), 'import { greet } from "./lib";\n\nconst msg = greet("world");\nconsole.log(msg);\n');
	return { dir, targetFile: "main.ts" };
}

async function lspFetch(op: string, sessionId: string, query: Record<string, string>): Promise<Response> {
	const token = readE2EToken();
	const qs = new URLSearchParams(query);
	return fetch(`${base()}/api/internal/lsp/${op}?${qs.toString()}`, {
		headers: { Authorization: `Bearer ${token}`, "X-Bobbit-Session-Id": sessionId },
	});
}

test.describe("GET /api/internal/lsp/*", () => {
	test("requires X-Bobbit-Session-Id", async () => {
		const token = readE2EToken();
		const resp = await fetch(`${base()}/api/internal/lsp/definition?file=x.ts&line=1&col=1`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(resp.status).toBe(403);
		const body = await resp.json();
		expect(body.error).toMatch(/X-Bobbit-Session-Id/i);
	});

	test("unknown session id -> 403", async () => {
		const resp = await lspFetch("definition", "no-such-session", { file: "x.ts", line: "1", col: "1" });
		expect(resp.status).toBe(403);
		const body = await resp.json();
		expect(body.error).toMatch(/not found/i);
	});

	test("missing file query param -> 400", async () => {
		const projectId = await defaultProjectId();
		const sessionId = await createSession({ projectId });
		try {
			const resp = await lspFetch("definition", sessionId, { line: "1", col: "1" });
			expect(resp.status).toBe(400);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("file path escaping the session worktree -> 400", async () => {
		const projectId = await defaultProjectId();
		const sessionId = await createSession({ projectId });
		try {
			const resp = await lspFetch("definition", sessionId, { file: "../../../etc/passwd", line: "1", col: "1" });
			expect(resp.status).toBe(400);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("no tsconfig.json reachable from the file -> available:false (fail-open, no spawn)", async () => {
		const dir = await makeFixtureDirUnderProject("notsconfig");
		writeFileSync(join(dir, "x.ts"), "export const x = 1;\n");
		const projectId = await defaultProjectId();
		const sessionId = await createSession({ projectId, cwd: dir });
		try {
			const resp = await lspFetch("definition", sessionId, { file: "x.ts", line: "1", col: "1" });
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.available).toBe(false);
			expect(body.reason).toMatch(/tsconfig\.json/);
		} finally {
			await deleteSession(sessionId).catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sandboxed session -> available:false, LSP not yet supported (design doc §6)", async ({ gateway }) => {
		const projectId = await defaultProjectId();
		const ctx = (gateway as any).projectContextManager.getOrCreate(projectId!);
		const dir = mkdtempSync(join(tmpdir(), "bobbit-lsp-e2e-sandboxed-"));
		const id = `lsp-e2e-sandboxed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const agentSessionFile = join(dir, `${id}.jsonl`);
		writeFileSync(agentSessionFile, JSON.stringify({ type: "system", cwd: dir }) + "\n");
		ctx.sessionStore.put({
			id,
			title: "sandboxed lsp e2e",
			cwd: dir,
			agentSessionFile,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			projectId,
			sandboxed: true,
		});
		try {
			const resp = await lspFetch("definition", id, { file: "x.ts", line: "1", col: "1" });
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.available).toBe(false);
			expect(body.reason).toMatch(/sandbox/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test.describe("happy path (real typescript-language-server)", () => {
		test.skip(!hasTsLanguageServer(), "typescript-language-server not installed in this environment");
		test.setTimeout(90_000);

		test("code_definition/code_references/code_hover/code_symbols resolve through a real session", async () => {
			const { dir, targetFile } = await makeFixtureProject();
			const projectId = await defaultProjectId();
			const sessionId = await createSession({ projectId, cwd: dir });
			try {
				const defResp = await lspFetch("definition", sessionId, { file: targetFile, line: "3", col: "14" });
				expect(defResp.status).toBe(200);
				const defBody = await defResp.json();
				expect(defBody.available).toBe(true);
				expect(defBody.locations.length).toBeGreaterThan(0);
				expect(defBody.locations[0].relativeFile).toBe("lib.ts");

				const refResp = await lspFetch("references", sessionId, { file: "lib.ts", line: "1", col: "17" });
				expect(refResp.status).toBe(200);
				const refBody = await refResp.json();
				expect(refBody.available).toBe(true);
				expect(refBody.totalCount).toBeGreaterThanOrEqual(1);

				const hoverResp = await lspFetch("hover", sessionId, { file: targetFile, line: "3", col: "14" });
				expect(hoverResp.status).toBe(200);
				const hoverBody = await hoverResp.json();
				expect(hoverBody.available).toBe(true);
				expect(typeof hoverBody.contents).toBe("string");
				expect(hoverBody.contents.length).toBeGreaterThan(0);

				const symResp = await lspFetch("symbols", sessionId, { file: "lib.ts" });
				expect(symResp.status).toBe(200);
				const symBody = await symResp.json();
				expect(symBody.available).toBe(true);
				expect(symBody.mode).toBe("file");
				expect(symBody.symbols.some((s: any) => s.name === "greet")).toBe(true);

				// Second call against the same worktree should be warm (well
				// under the cold-load timeout) — a light assertion that the
				// per-worktree instance is actually being reused, not
				// respawned per call.
				const start = Date.now();
				const symResp2 = await lspFetch("symbols", sessionId, { file: "lib.ts" });
				expect(symResp2.status).toBe(200);
				expect(Date.now() - start).toBeLessThan(15_000);
			} finally {
				await deleteSession(sessionId).catch(() => {});
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

/**
 * API E2E — per-turn provider hooks (Extension Platform G1.4).
 *
 * Exercises the gateway surfaces that wire provider lifecycle hooks for a turn:
 *   - POST /api/sessions/:id/provider-hooks/before-prompt  (beforePrompt dispatch
 *     + dynamic-context message content synthesis; the generated provider-bridge
 *     pi extension turns this into a hidden custom/user-side message).
 *   - GET  /api/sessions/:id/context-trace                 (per-turn diagnostics).
 *   - afterTurn        — fired server-side from the agent_end lifecycle seam.
 *   - sessionShutdown  — fired server-side from the archive seam.
 *
 * Fixture-pack install pattern mirrors provider-session-setup.spec.ts: the
 * provider-demo pack is layered as a SERVER-SCOPE market pack under the
 * per-gateway Headquarters config dir on top of the real built-in band (NOT via
 * BOBBIT_BUILTIN_PACKS_DIR, which would clobber sibling specs sharing the
 * worker-scoped in-process gateway).
 *
 * NON-NEGOTIABLE invariant pinned here: the user's message text is never mutated
 * by the per-turn hooks — recall lands in a hidden custom/user-side message, not
 * the cached system prompt. The turn echoes back the exact submitted bytes.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	connectWs,
	agentEndPredicate,
	messageEndPredicate,
	waitForCondition,
	assertStaysFalse,
	nonGitCwd,
} from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
	DYNAMIC_CONTEXT_END,
	DYNAMIC_CONTEXT_START,
	generateProviderBridgeExtension,
} from "../../src/server/agent/provider-bridge-extension.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturePackDir = path.resolve(__dirname, "..", "fixtures", "packs", "provider-demo");
const PACK_NAME = "provider-demo";

interface TraceProviderRow { id: string; ms: number; blocks: number; omitted: number; error?: string }
interface TraceEntry { ts: number; hook: string; sessionId: string; providers: TraceProviderRow[] }

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

function installPack(headquartersDir: string): string {
	const packDir = path.join(headquartersDir, "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.cpSync(fixturePackDir, packDir, { recursive: true });
	writeMeta(packDir);
	return packDir;
}

async function setProviderDisabled(providers: string[]): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { providers } }),
	});
	expect(resp.status).toBe(200);
}

interface BeforePromptResult { status: number; content: string; tail: string; blocks: Array<Record<string, unknown>> }

async function callBeforePrompt(sessionId: string, prompt: string): Promise<BeforePromptResult> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		body: JSON.stringify({ prompt }),
	});
	const body = resp.status === 200 ? await resp.json() : {};
	return {
		status: resp.status,
		content: typeof body.content === "string" ? body.content : "",
		tail: typeof body.tail === "string" ? body.tail : "",
		blocks: Array.isArray(body.blocks) ? body.blocks : [],
	};
}

async function registerGeneratedBridgeHandlers(sessionId: string, tempDir: string): Promise<Map<string, (event: any) => Promise<any> | any>> {
	const source = generateProviderBridgeExtension(sessionId);
	const transpiled = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	const file = path.join(tempDir, `provider-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);
	fs.writeFileSync(file, transpiled.outputText, "utf-8");
	const mod = await import(pathToFileURL(file).href);
	const extensionFactory = typeof mod.default === "function" ? mod.default : mod.default?.default;
	expect(typeof extensionFactory, "generated bridge default export").toBe("function");
	const handlers = new Map<string, (event: any) => Promise<any> | any>();
	extensionFactory({ on: (event: string, handler: (event: any) => Promise<any> | any) => handlers.set(event, handler) });
	return handlers;
}

async function registerGeneratedBeforeAgentStart(sessionId: string, tempDir: string): Promise<(event: any) => Promise<any>> {
	const handlers = await registerGeneratedBridgeHandlers(sessionId, tempDir);
	const handler = handlers.get("before_agent_start");
	expect(typeof handler, "generated bridge registered before_agent_start").toBe("function");
	return handler as (event: any) => Promise<any>;
}

async function readContextTrace(sessionId: string, limit?: number): Promise<TraceEntry[]> {
	const qs = typeof limit === "number" ? `?limit=${limit}` : "";
	const resp = await apiFetch(`/api/sessions/${sessionId}/context-trace${qs}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	// Tolerate either a bare array or a wrapped { trace | entries } shape.
	if (Array.isArray(body)) return body as TraceEntry[];
	if (Array.isArray(body?.trace)) return body.trace as TraceEntry[];
	if (Array.isArray(body?.entries)) return body.entries as TraceEntry[];
	return [];
}

function readLog(cwd: string): string[] {
	const logPath = path.join(cwd, ".provider-demo-log");
	if (!fs.existsSync(logPath)) return [];
	return fs.readFileSync(logPath, "utf-8").trim().split(/\r?\n/).filter(Boolean);
}

async function driveTurn(sessionId: string, prompt: string): Promise<string> {
	const conn = await connectWs(sessionId);
	try {
		const userEnd = conn.waitFor(messageEndPredicate("user"));
		conn.send({ type: "prompt", text: prompt });
		const echoed = await userEnd;
		await conn.waitFor(agentEndPredicate(), 15_000);
		const content = echoed.data.message.content;
		const text = Array.isArray(content)
			? content.find((c: any) => c.type === "text")?.text
			: content;
		return text ?? "";
	} finally {
		conn.close();
	}
}

test.describe("provider per-turn hooks", () => {
	const sessions: string[] = [];
	const cwds: string[] = [];
	let packDir: string;

	function freshCwd(label: string): string {
		const cwd = fs.mkdtempSync(path.join(nonGitCwd(), `provider-turn-${label}-`));
		cwds.push(cwd);
		return cwd;
	}

	async function newSession(label: string): Promise<{ id: string; cwd: string }> {
		const cwd = freshCwd(label);
		const id = await createSession({ cwd });
		sessions.push(id);
		return { id, cwd };
	}

	test.beforeAll(async ({ gateway }) => {
		packDir = installPack(gateway.bobbitDir);
		await setProviderDisabled([]);
	});

	test.afterAll(async () => {
		await setProviderDisabled([]).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
	});

	test.afterEach(async () => {
		// Disable everything so the next test starts from a known-quiet baseline
		// and no provider hook fires during teardown deletes.
		await setProviderDisabled(["demo", "boom", "slow"]).catch(() => {});
		for (const id of sessions.splice(0)) await deleteSession(id).catch(() => {});
		for (const cwd of cwds.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
	});

	test("beforePrompt returns dynamic-context message content, then afterTurn fires; both appear in the context trace", async () => {
		// demo + boom enabled; slow disabled so the happy path stays deterministic.
		await setProviderDisabled(["slow"]);
		const { id, cwd } = await newSession("happy");

		// sessionSetup is dispatched at creation.
		expect(readLog(cwd)).toEqual(["sessionSetup"]);

		const promptText = "Summarize the quarterly metrics";
		const before = await callBeforePrompt(id, promptText);
		expect(before.status).toBe(200);

		// The endpoint returns message content carrying the demo block — and a
		// temporary legacy tail for older generated bridges. New bridges ignore tail
		// and must NOT leak dynamic context into or rewrite the user's message text.
		expect(before.content, "beforePrompt must return custom-message content").toContain("<context-block");
		expect(before.content).toContain(`DEMO_BEFORE_PROMPT ${promptText}`);
		expect(before.tail, "beforePrompt must retain a temporary legacy tail for old bridges").toContain(DYNAMIC_CONTEXT_START);
		expect(before.tail).toContain(before.content);
		expect(before.tail).toContain(DYNAMIC_CONTEXT_END);

		// Metadata-only block summary (no raw content field leaked).
		const demoBlock = before.blocks.find((b) => b.id === "demo:turn");
		expect(demoBlock).toBeTruthy();
		expect(demoBlock!.providerId).toBe("demo");
		expect(demoBlock!.title).toBe("Demo turn");
		expect(typeof demoBlock!.tokenEstimate).toBe("number");
		expect("content" in demoBlock!).toBe(false);

		// Drive the actual turn — afterTurn is dispatched server-side on agent_end.
		const echoed = await driveTurn(id, promptText);

		// INVARIANT: user message text is byte-identical to what was submitted.
		expect(echoed).toBe(promptText);

		// afterTurn lands asynchronously after agent_end; poll for it.
		await waitForCondition(() => readLog(cwd).includes("afterTurn"), {
			timeoutMs: 10_000, message: "afterTurn logged",
		});
		expect(readLog(cwd)).toEqual(["sessionSetup", "beforePrompt", "afterTurn"]);

		// Context trace lists both dispatches with per-provider timing rows.
		const trace = await readContextTrace(id);
		const bp = trace.find((e) => e.hook === "beforePrompt");
		const at = trace.find((e) => e.hook === "afterTurn");
		expect(bp, "beforePrompt trace entry").toBeTruthy();
		expect(at, "afterTurn trace entry").toBeTruthy();
		const bpDemo = bp!.providers.find((p) => p.id === "demo");
		expect(bpDemo, "demo timing row on beforePrompt").toBeTruthy();
		expect(typeof bpDemo!.ms).toBe("number");
		expect(bpDemo!.blocks).toBe(1);
		expect(at!.providers.some((p) => p.id === "demo")).toBe(true);
	});

	test("generated bridge delivers dynamic context as a hidden custom message and keeps system prompt stable", async () => {
		await setProviderDisabled(["slow"]);
		const { id, cwd } = await newSession("bridge");
		const handlers = await registerGeneratedBridgeHandlers(id, cwd);
		const beforeAgentStart = handlers.get("before_agent_start") as (event: any) => Promise<any>;
		const filterContext = handlers.get("context") as (event: any) => any;
		expect(typeof beforeAgentStart, "generated bridge registered before_agent_start").toBe("function");
		expect(typeof filterContext, "generated bridge registered context").toBe("function");
		const baseSystemPrompt = "BASE SYSTEM PROMPT\n(sessionSetup dynamic context is already stable here)";
		let piSystemPrompt = baseSystemPrompt;
		const prompts = ["turn A cache probe", "turn B cache probe"];
		const systemPromptSnapshots: string[] = [];
		const dynamicMessages: any[] = [];

		for (const prompt of prompts) {
			const result = await beforeAgentStart({ prompt, systemPrompt: piSystemPrompt });
			expect(result, "before_agent_start must return a hidden bobbit:dynamic-context custom message, not systemPrompt")
				.toMatchObject({
					message: {
						customType: "bobbit:dynamic-context",
						display: false,
					},
				});
			expect(result).not.toHaveProperty("systemPrompt");
			expect(result).not.toHaveProperty("prompt");
			expect(result.message.content).toContain(`DEMO_BEFORE_PROMPT ${prompt}`);
			dynamicMessages.push({ role: "custom", ...result.message });
			if (typeof result.systemPrompt === "string") piSystemPrompt = result.systemPrompt;
			systemPromptSnapshots.push(piSystemPrompt);
		}

		expect(dynamicMessages).toEqual([
			expect.objectContaining({ role: "custom", customType: "bobbit:dynamic-context", display: false }),
			expect.objectContaining({ role: "custom", customType: "bobbit:dynamic-context", display: false }),
		]);
		expect(systemPromptSnapshots, "changing beforePrompt blocks must not change cached system prompt bytes")
			.toEqual([baseSystemPrompt, baseSystemPrompt]);
		expect(dynamicMessages[0].content).toContain("turn A cache probe");
		expect(dynamicMessages[1].content).toContain("turn B cache probe");
		expect(dynamicMessages[0].content).not.toBe(dynamicMessages[1].content);

		const llmContextMessages = [
			{ role: "user", content: [{ type: "text", text: prompts[0] }] },
			dynamicMessages[0],
			{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			{ role: "user", content: [{ type: "text", text: prompts[1] }] },
			dynamicMessages[1],
		];
		const filtered = filterContext({ type: "context", messages: llmContextMessages });
		expect(filtered?.messages, "context hook must filter stale persisted dynamic context").toBeTruthy();
		expect(JSON.stringify(filtered.messages)).not.toContain("DEMO_BEFORE_PROMPT turn A cache probe");
		expect(JSON.stringify(filtered.messages)).toContain("DEMO_BEFORE_PROMPT turn B cache probe");
		expect(filtered.messages.at(-1)).toBe(dynamicMessages[1]);
	});

	test("context-trace honours the limit query param", async () => {
		await setProviderDisabled(["slow"]);
		const { id } = await newSession("limit");
		// Generate several beforePrompt dispatches (each appends one trace entry).
		for (let i = 0; i < 3; i++) await callBeforePrompt(id, `turn ${i}`);

		const limited = await readContextTrace(id, 2);
		expect(limited.length).toBeLessThanOrEqual(2);
		// The most-recent entries are returned; the last is a beforePrompt.
		expect(limited.at(-1)!.hook).toBe("beforePrompt");
	});

	test("disabling the provider is a kill switch — no hook fires for the next turn", async () => {
		await setProviderDisabled(["demo", "boom", "slow"]);
		const { id, cwd } = await newSession("disabled");

		// No sessionSetup ran, so no log file exists at all.
		expect(fs.existsSync(path.join(cwd, ".provider-demo-log"))).toBe(false);

		const before = await callBeforePrompt(id, "anything");
		expect(before.status).toBe(200);
		expect(before.content).toBe("");
		expect(before.tail).toBe("");
		expect(before.blocks).toEqual([]);

		await driveTurn(id, "anything");

		// No provider hook may write a log line for the disabled pack — assert the
		// log file stays absent across a window (catches any erroneous async
		// afterTurn dispatch the moment it fires).
		await assertStaysFalse(() => fs.existsSync(path.join(cwd, ".provider-demo-log")), {
			durationMs: 500, message: "disabled provider wrote a hook log",
		});
	});

	test("a hanging provider is bounded by its timeout — endpoint returns empty content with a timeout trace row", async () => {
		// Only the slow (hanging) provider is enabled.
		await setProviderDisabled(["demo", "boom"]);
		const { id } = await newSession("hang");

		const t0 = Date.now();
		const before = await callBeforePrompt(id, "hangs");
		const elapsed = Date.now() - t0;

		expect(before.status).toBe(200);
		expect(before.content).toBe("");
		expect(before.tail).toBe("");
		// slow.yaml budget.timeoutMs is 300ms; the endpoint must respond well
		// within a few seconds rather than the provider's 30s sleep.
		expect(elapsed).toBeLessThan(5_000);

		const trace = await readContextTrace(id);
		const bp = trace.find((e) => e.hook === "beforePrompt");
		expect(bp, "beforePrompt trace entry").toBeTruthy();
		const slowRow = bp!.providers.find((p) => p.id === "slow");
		expect(slowRow, "slow timing row").toBeTruthy();
		expect(slowRow!.error ?? "").toMatch(/timeout/i);
	});

	test("archiving a session dispatches sessionShutdown", async () => {
		await setProviderDisabled(["slow"]);
		const { id, cwd } = await newSession("shutdown");
		expect(readLog(cwd)).toEqual(["sessionSetup"]);

		await deleteSession(id);
		// Don't let afterEach try to delete it again.
		const idx = sessions.indexOf(id);
		if (idx >= 0) sessions.splice(idx, 1);

		await waitForCondition(() => readLog(cwd).includes("sessionShutdown"), {
			timeoutMs: 10_000, message: "sessionShutdown logged",
		});

		const trace = await readContextTrace(id);
		expect(trace.some((e) => e.hook === "sessionShutdown")).toBe(true);
	});
});

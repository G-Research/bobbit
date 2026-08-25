/**
 * Opt-in real Pi / real-model smoke for reliable delivery through automatic
 * context compaction.
 *
 * Exact invocation:
 *   npm run test:manual -- tests/manual-integration/reliable-agent-context-pressure.spec.ts --project=manual-integration --workers=1
 *
 * Prerequisite (no provider fallback): either set MANUAL_TEST_MODEL together
 * with credentials for that exact provider, or explicitly inherit the live
 * server's model/auth subset with BOBBIT_MANUAL_INHERIT_SERVER_CONFIG=1 and
 * BOBBIT_DIR. The gateway and Pi agent directory remain isolated in both modes.
 */
import { test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { buildDefaultWorkflows } from "../../src/server/state-migration/seed-default-workflows.ts";
import {
	MANUAL_INHERIT_SERVER_CONFIG_ENV,
	seedManualTestModelPreferences,
} from "./_helpers/manual-test-model-seeding.ts";
import { manualTmpRoot } from "./_helpers/manual-test-paths.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");
const MAX_MODEL_REQUESTS = 6;
const MAX_AGGREGATE_TOKENS = 250_000;
const MAX_REPORTED_COST_USD = 2;
const MODEL_SCENARIO_TIMEOUT_MS = 8 * 60_000;
const PRESSURE_CONTEXT_WINDOW = 48_000;
const MAX_PRESSURE_TURNS = 4;
const PRESSURE_BODY_CHARS = 60_000;

interface Gateway {
	proc: ChildProcess;
	port: number;
	dir: string;
	agentDir: string;
	token: string;
	base: string;
	projectId?: string;
}

interface ModelTuple {
	provider: string;
	id: string;
}

interface CostSnapshot {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
}

type Frame = Record<string, any>;
type FramePredicate = (frame: Frame) => boolean;

function enabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

const directModel = process.env.MANUAL_TEST_MODEL?.trim();
const inheritRequested = enabled(process.env[MANUAL_INHERIT_SERVER_CONFIG_ENV]);
const inheritedRoot = process.env.BOBBIT_DIR?.trim();
const hasDocumentedPrerequisite = !!directModel || (inheritRequested && !!inheritedRoot);
const prerequisiteMessage =
	"Real context-pressure smoke skipped: set MANUAL_TEST_MODEL=<provider>/<model> with isolated provider credentials, " +
	`or set ${MANUAL_INHERIT_SERVER_CONFIG_ENV}=1 with BOBBIT_DIR. No default-provider fallback is permitted.`;

function parseModel(value: string): ModelTuple {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`Manual context-pressure configuration is invalid: model must be <provider>/<model>.`);
	}
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function readObject(path: string): Record<string, any> {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf-8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Manual context-pressure configuration is invalid: expected an object at ${path}.`);
	}
	return parsed;
}

/**
 * Keep the provider route and credentials exact, but lower Pi's advertised
 * window in the isolated agent directory. Context is still genuinely grown
 * past Pi's threshold; the override only makes that feasible within the hard
 * token, request, cost, and wall-clock guards.
 */
function configureIsolatedModel(dir: string): ModelTuple | undefined {
	seedManualTestModelPreferences(dir);
	const stateDir = join(dir, ".bobbit", "state");
	const prefsPath = join(stateDir, "preferences.json");
	const prefs = readObject(prefsPath);
	const configured = directModel || (typeof prefs["default.sessionModel"] === "string"
		? prefs["default.sessionModel"].trim()
		: "");
	if (!configured) return undefined;
	const tuple = parseModel(configured);

	prefs["default.sessionModel"] = configured;
	prefs.allowSessionModelFallback = false;
	writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));

	const agentDir = join(dir, ".bobbit", "agent");
	mkdirSync(agentDir, { recursive: true });
	const modelsPath = join(agentDir, "models.json");
	const models = readObject(modelsPath);
	models.providers ??= {};
	models.providers[tuple.provider] ??= {};
	models.providers[tuple.provider].modelOverrides ??= {};
	models.providers[tuple.provider].modelOverrides[tuple.id] = {
		...(models.providers[tuple.provider].modelOverrides[tuple.id] ?? {}),
		contextWindow: PRESSURE_CONTEXT_WINDOW,
	};
	writeFileSync(modelsPath, JSON.stringify(models, null, 2));
	return tuple;
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "manual-context-pressure@example.invalid"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Manual Context Pressure"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "# Isolated context-pressure fixture\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "context-pressure-fixture", private: true }, null, 2));
	execFileSync("git", ["add", "README.md", "package.json"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "fixture"], { cwd: dir, stdio: "ignore" });
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolvePort(port));
		});
		server.on("error", reject);
	});
}

async function startGateway(dir: string, port: number): Promise<Gateway> {
	const agentDir = join(dir, ".bobbit", "agent");
	const proc = spawn(process.execPath, [
		SERVER_CLI,
		"--host", "127.0.0.1",
		"--port", String(port),
		"--no-tls",
		"--auth",
		"--cwd", dir,
	], {
		env: {
			...process.env,
			BOBBIT_DIR: join(dir, ".bobbit"),
			BOBBIT_AGENT_DIR: agentDir,
			BOBBIT_SECRETS_DIR: join(dir, ".bobbit", "state"),
			BOBBIT_SKIP_TITLE_GEN: "1",
			BOBBIT_NO_OPEN: "1",
			NODE_ENV: "test",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Drain child output without retaining it. Failure diagnostics must never
	// reproduce prompt or provider bodies.
	proc.stdout?.resume();
	proc.stderr?.resume();

	try {
		const stateDir = join(dir, ".bobbit", "state");
		const tokenPath = join(stateDir, "token");
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null) {
				throw new Error(`Manual context-pressure gateway exited during startup (code=${proc.exitCode}).`);
			}
			if (existsSync(tokenPath)) {
				const token = readFileSync(tokenPath, "utf-8").trim();
				try {
					const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
						headers: { Authorization: `Bearer ${token}` },
					});
					if (health.ok) {
						return { proc, port, dir, agentDir, token, base: `http://127.0.0.1:${port}` };
					}
				} catch {
					// Startup readiness polling is outside the model lifecycle.
				}
			}
			await new Promise(resolveWait => setTimeout(resolveWait, 250));
		}
		throw new Error("Manual context-pressure gateway did not become healthy within 120000ms.");
	} catch (error) {
		if (proc.exitCode === null) {
			if (process.platform === "win32") {
				try { execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 }); } catch {}
			} else {
				try { proc.kill("SIGKILL"); } catch {}
			}
		}
		throw error;
	}
}

async function stopGateway(gateway: Gateway): Promise<void> {
	if (gateway.proc.exitCode === null) {
		if (process.platform === "win32") {
			try {
				execFileSync("taskkill", ["/PID", String(gateway.proc.pid), "/T", "/F"], {
					stdio: "ignore",
					timeout: 10_000,
				});
			} catch {}
		} else {
			gateway.proc.kill();
		}
	}
	await new Promise<void>(resolveExit => {
		if (gateway.proc.exitCode !== null) return resolveExit();
		gateway.proc.once("exit", () => resolveExit());
		setTimeout(() => {
			try { gateway.proc.kill("SIGKILL"); } catch {}
			resolveExit();
		}, 5_000);
	});
}

function api(gateway: Gateway, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${gateway.base}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${gateway.token}`,
			...((init.headers as Record<string, string> | undefined) ?? {}),
		},
	});
}

function projectRegistrationBody(rootPath: string): Record<string, unknown> {
	const name = "Reliable context pressure";
	const commands = {
		build: "echo build ok",
		check: "echo check ok",
		unit: "echo unit ok",
		e2e: "echo e2e ok",
	};
	return {
		name,
		rootPath,
		components: [{
			name,
			repo: ".",
			commands,
		}],
		workflows: buildDefaultWorkflows(name, Object.keys(commands)),
	};
}

function eventOf(frame: Frame): Frame | undefined {
	return frame.type === "event" && frame.data && typeof frame.data === "object"
		? frame.data
		: undefined;
}

function eventType(frame: Frame): string | undefined {
	return eventOf(frame)?.type;
}

function roleOfEvent(frame: Frame): string | undefined {
	return eventOf(frame)?.message?.role;
}

function deliveryIntentId(frame: Frame): string | undefined {
	const event = eventOf(frame);
	if (!event) return undefined;
	const candidates = [
		event.deliveryIntentId,
		event.intentId,
		event.delivery?.intentId,
		event.message?.deliveryIntentId,
		event.message?.intentId,
		event.message?.delivery?.intentId,
		event.message?.metadata?.deliveryIntentId,
		event.message?.metadata?.intentId,
	];
	return candidates.find(value => typeof value === "string");
}

function isAutomaticCompactionStart(frame: Frame): boolean {
	const event = eventOf(frame);
	return !!event
		&& (event.type === "auto_compaction_start" || event.type === "compaction_start")
		&& (event.reason === "threshold" || event.reason === "overflow");
}

function isCompactionEnd(frame: Frame): boolean {
	const type = eventType(frame);
	return type === "auto_compaction_end" || type === "compaction_end";
}

function isFinalAgentEnd(frame: Frame): boolean {
	const event = eventOf(frame);
	return event?.type === "agent_end" && event.willRetry !== true;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => block && typeof block === "object" && typeof (block as any).text === "string" ? (block as any).text : "")
		.join("");
}

function assistantEndText(frame: Frame): string {
	const event = eventOf(frame);
	if (event?.type !== "message_end" || event.message?.role !== "assistant") return "";
	return textFromContent(event.message.content);
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function frameSummary(frame: Frame): Record<string, unknown> | undefined {
	if (frame.type === "session_status") {
		return { frame: "status", status: frame.status, version: frame.statusVersion };
	}
	if (frame.type === "cost_update") {
		const cost = frame.cost ?? {};
		return {
			frame: "cost",
			input: numberOrZero(cost.inputTokens),
			output: numberOrZero(cost.outputTokens),
			cacheRead: numberOrZero(cost.cacheReadTokens),
			cacheWrite: numberOrZero(cost.cacheWriteTokens),
			usd: numberOrZero(cost.totalCost),
		};
	}
	if (frame.type === "queue_update") {
		return {
			frame: "outbox",
			rows: (Array.isArray(frame.queue) ? frame.queue : []).map((row: any) => ({
				id: row?.intentId ?? row?.id,
				kind: row?.kind,
				target: row?.targetTurn,
				state: row?.deliveryState,
			})),
		};
	}
	const event = eventOf(frame);
	if (!event) return undefined;
	return {
		frame: "event",
		type: event.type,
		reason: event.reason,
		willRetry: event.willRetry,
		aborted: event.aborted,
		stopReason: event.message?.stopReason,
		role: event.message?.role,
		intentId: deliveryIntentId(frame),
		compactionId: event.compactionId,
	};
}

class LifecycleStream {
	readonly frames: Frame[] = [];
	readonly summaries: Record<string, unknown>[] = [];
	latestCost: CostSnapshot = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	};
	assistantRequestStarts = 0;
	agentStarts = 0;
	automaticCompactionStarts = 0;

	private readonly listeners = new Set<(frame: Frame) => void>();
	private readonly waiters = new Set<{
		from: number;
		predicate: FramePredicate;
		resolve: (value: { frame: Frame; index: number }) => void;
		reject: (error: Error) => void;
		label: string;
	}>();
	private budgetFailure?: Error;
	private wallTimer?: NodeJS.Timeout;

	private constructor(
		private readonly socket: WebSocket,
		readonly sessionId: string,
		readonly model: ModelTuple,
	) {}

	static async connect(gateway: Gateway, sessionId: string, model: ModelTuple): Promise<LifecycleStream> {
		const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws/${encodeURIComponent(sessionId)}`);
		const stream = new LifecycleStream(socket, sessionId, model);
		await new Promise<void>((resolveReady, rejectReady) => {
			const timeout = setTimeout(() => rejectReady(new Error("Session WebSocket authentication timed out.")), 30_000);
			socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token: gateway.token, clientKind: "app" })));
			socket.on("message", raw => {
				let frame: Frame;
				try { frame = JSON.parse(raw.toString()); } catch { return; }
				stream.accept(frame);
				if (frame.type === "auth_ok") {
					clearTimeout(timeout);
					resolveReady();
				} else if (frame.type === "auth_failed") {
					clearTimeout(timeout);
					rejectReady(new Error("Session WebSocket authentication failed."));
				}
			});
			socket.once("error", error => {
				clearTimeout(timeout);
				rejectReady(error);
			});
		});
		return stream;
	}

	startBudget(): void {
		this.wallTimer = setTimeout(() => {
			this.failBudget("WALL_CLOCK_CAP_REACHED", { limitMs: MODEL_SCENARIO_TIMEOUT_MS });
		}, MODEL_SCENARIO_TIMEOUT_MS);
	}

	count(): number {
		return this.frames.length;
	}

	subscribe(listener: (frame: Frame) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	assertRequestCapacity(reserve: number, phase: string): void {
		const observed = this.modelRequestEstimate();
		if (observed + reserve > MAX_MODEL_REQUESTS) {
			throw this.failure("MODEL_REQUEST_CAP_WOULD_BE_EXCEEDED", {
				limit: MAX_MODEL_REQUESTS,
				observed,
				reserve,
				phase,
			});
		}
	}

	send(frame: Frame): void {
		if (this.budgetFailure) throw this.budgetFailure;
		if (this.socket.readyState !== WebSocket.OPEN) {
			throw this.failure("SESSION_SOCKET_NOT_OPEN", { readyState: this.socket.readyState });
		}
		this.socket.send(JSON.stringify(frame));
	}

	async waitForFrom(from: number, predicate: FramePredicate, label: string): Promise<{ frame: Frame; index: number }> {
		if (this.budgetFailure) throw this.budgetFailure;
		for (let index = from; index < this.frames.length; index++) {
			if (predicate(this.frames[index])) return { frame: this.frames[index], index };
		}
		return new Promise((resolveWait, rejectWait) => {
			this.waiters.add({ from, predicate, resolve: resolveWait, reject: rejectWait, label });
		});
	}

	failure(code: string, extra: Record<string, unknown> = {}): Error {
		const aggregateTokens = this.aggregateTokens();
		return new Error(`${code}: ${JSON.stringify({
			sessionId: this.sessionId,
			model: this.model,
			assistantRequestStarts: this.assistantRequestStarts,
			agentStarts: this.agentStarts,
			automaticCompactionStarts: this.automaticCompactionStarts,
			modelRequestEstimate: this.modelRequestEstimate(),
			aggregateTokens,
			reportedCostUsd: this.latestCost.totalCost,
			...extra,
			lifecycle: this.summaries.slice(-80),
		})}`);
	}

	close(): void {
		if (this.wallTimer) clearTimeout(this.wallTimer);
		this.wallTimer = undefined;
		this.socket.close();
		for (const waiter of this.waiters) waiter.reject(this.failure("SESSION_SOCKET_CLOSED", { waitingFor: waiter.label }));
		this.waiters.clear();
	}

	private accept(frame: Frame): void {
		const index = this.frames.push(frame) - 1;
		const summary = frameSummary(frame);
		if (summary) {
			this.summaries.push(summary);
			if (this.summaries.length > 160) this.summaries.shift();
		}
		if (frame.type === "cost_update") {
			const cost = frame.cost ?? {};
			this.latestCost = {
				inputTokens: numberOrZero(cost.inputTokens),
				outputTokens: numberOrZero(cost.outputTokens),
				cacheReadTokens: numberOrZero(cost.cacheReadTokens),
				cacheWriteTokens: numberOrZero(cost.cacheWriteTokens),
				totalCost: numberOrZero(cost.totalCost),
			};
		}
		if (eventType(frame) === "message_start" && roleOfEvent(frame) === "assistant") {
			this.assistantRequestStarts++;
		}
		if (eventType(frame) === "agent_start") this.agentStarts++;
		if (isAutomaticCompactionStart(frame)) this.automaticCompactionStarts++;

		const requestCount = this.modelRequestEstimate();
		if (requestCount >= MAX_MODEL_REQUESTS) {
			// Abort as the sixth call starts, before an event listener can admit
			// more work. A seventh request is therefore never intentionally queued.
			this.failBudget("MODEL_REQUEST_CAP_REACHED", { limit: MAX_MODEL_REQUESTS, observed: requestCount });
			return;
		}
		if (this.aggregateTokens() >= MAX_AGGREGATE_TOKENS) {
			this.failBudget("AGGREGATE_TOKEN_CAP_REACHED", { limit: MAX_AGGREGATE_TOKENS });
			return;
		}
		if (this.latestCost.totalCost >= MAX_REPORTED_COST_USD) {
			this.failBudget("REPORTED_COST_CAP_REACHED", { limitUsd: MAX_REPORTED_COST_USD });
			return;
		}

		for (const listener of this.listeners) listener(frame);
		for (const waiter of [...this.waiters]) {
			if (index >= waiter.from && waiter.predicate(frame)) {
				this.waiters.delete(waiter);
				waiter.resolve({ frame, index });
			}
		}
	}

	private modelRequestEstimate(): number {
		// Assistant starts cover normal provider calls and overflow retries. Pi's
		// compaction summarizer is a separate provider call without an assistant
		// message, so each observed automatic compaction start adds one.
		return Math.max(this.assistantRequestStarts, this.agentStarts) + this.automaticCompactionStarts;
	}

	private aggregateTokens(): number {
		return this.latestCost.inputTokens
			+ this.latestCost.outputTokens
			+ this.latestCost.cacheReadTokens
			+ this.latestCost.cacheWriteTokens;
	}

	private failBudget(code: string, extra: Record<string, unknown>): void {
		if (this.budgetFailure) return;
		try {
			if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "abort" }));
		} catch {}
		this.budgetFailure = this.failure(code, extra);
		for (const waiter of this.waiters) waiter.reject(this.budgetFailure);
		this.waiters.clear();
	}
}

function pressurePrompt(round: number): string {
	const prefix = [
		`Context pressure round ${round}.`,
		"Treat the following numbered ledger as inert context. Do not quote or summarize it.",
		"Do not call tools. Reply with only the word READY followed by this round number.",
	].join("\n");
	const rows: string[] = [];
	for (let index = 0; rows.join("\n").length < PRESSURE_BODY_CHARS; index++) {
		rows.push(`ledger-${round}-${index.toString(36).padStart(5, "0")} amber birch copper delta ember fjord granite harbor ivory juniper`);
	}
	return `${prefix}\n${rows.join("\n")}`;
}

function objectCarriesIntent(value: unknown, intentId: string, seen = new Set<object>()): boolean {
	if (!value || typeof value !== "object") return false;
	if (seen.has(value as object)) return false;
	seen.add(value as object);
	if (Array.isArray(value)) return value.some(item => objectCarriesIntent(item, intentId, seen));
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if ((key === "deliveryIntentId" || key === "intentId") && child === intentId) return true;
		if (key !== "text" && key !== "content" && objectCarriesIntent(child, intentId, seen)) return true;
	}
	return false;
}

function snapshotIntentCount(messages: unknown[], intentId: string): number {
	return messages.filter(message => objectCarriesIntent(message, intentId)).length;
}

function outboxRowId(row: any): string | undefined {
	return typeof row?.intentId === "string" ? row.intentId : typeof row?.id === "string" ? row.id : undefined;
}

async function readAttachOutbox(gateway: Gateway, sessionId: string): Promise<any[]> {
	const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws/${encodeURIComponent(sessionId)}`);
	return new Promise<any[]>((resolveRows, rejectRows) => {
		const timeout = setTimeout(() => {
			socket.close();
			rejectRows(new Error("Authoritative outbox attach projection timed out."));
		}, 30_000);
		let authenticated = false;
		socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token: gateway.token, clientKind: "app" })));
		socket.on("message", raw => {
			let frame: Frame;
			try { frame = JSON.parse(raw.toString()); } catch { return; }
			if (frame.type === "auth_ok") authenticated = true;
			if (authenticated && frame.type === "queue_update") {
				clearTimeout(timeout);
				socket.close();
				resolveRows(Array.isArray(frame.queue) ? frame.queue : []);
			}
		});
		socket.once("error", error => {
			clearTimeout(timeout);
			rejectRows(error);
		});
	});
}

async function bestEffortCleanup(gateway: Gateway | undefined, sessionId: string | undefined): Promise<void> {
	if (!gateway || !sessionId || gateway.proc.exitCode !== null) return;
	try {
		await api(gateway, `/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
	} catch {}
	try {
		await api(gateway, `/api/sessions/${encodeURIComponent(sessionId)}?purge=true`, { method: "DELETE" });
	} catch {}
}

test.describe.configure({ mode: "serial" });
test.skip(!hasDocumentedPrerequisite, prerequisiteMessage);

test("real context pressure preserves steer and follow-up through automatic compaction", async () => {
	// Startup may consume its full 120s before the separately measured eight-minute
	// model scenario. Leave a bounded cleanup margin so our body-free budget error,
	// rather than Playwright's generic timeout, remains authoritative.
	test.setTimeout(630_000);

	const port = await freePort();
	const dir = join(manualTmpRoot(), `.bobbit-reliable-context-${port}`);
	let gateway: Gateway | undefined;
	let stream: LifecycleStream | undefined;
	let sessionId: string | undefined;
	try {
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

		const configuredModel = configureIsolatedModel(dir);
		if (!configuredModel) {
			test.skip(true, prerequisiteMessage);
			return;
		}

		gateway = await startGateway(dir, port);
		const modelsResponse = await api(gateway, "/api/models");
		if (!modelsResponse.ok) throw new Error(`Manual model preflight failed with status ${modelsResponse.status}.`);
		const models = await modelsResponse.json() as Array<Record<string, any>>;
		const selected = models.find(model => model.provider === configuredModel.provider && model.id === configuredModel.id);
		if (!selected || selected.authenticated !== true || selected.sessionSelectable === false) {
			test.skip(true,
				`Real context-pressure smoke skipped: exact configured model ${configuredModel.provider}/${configuredModel.id} ` +
				`is ${!selected ? "absent" : selected.authenticated !== true ? "not authenticated" : "not session-selectable"}. ` +
				"Configure that provider explicitly; fallback is disabled.");
			return;
		}
		if (selected.contextWindow !== PRESSURE_CONTEXT_WINDOW) {
			throw new Error(`CONTEXT_OVERRIDE_NOT_ACTIVE: ${JSON.stringify({
				model: configuredModel,
				expectedContextWindow: PRESSURE_CONTEXT_WINDOW,
				observedContextWindow: selected.contextWindow,
			})}`);
		}

		const registration = await api(gateway, "/api/projects", {
			method: "POST",
			body: JSON.stringify(projectRegistrationBody(dir)),
		});
		if (registration.status !== 200 && registration.status !== 201) {
			throw new Error(`Manual context-pressure project registration failed with status ${registration.status}.`);
		}
		gateway.projectId = (await registration.json()).id;

		const creation = await api(gateway, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: gateway.projectId, worktree: false, sandboxed: false }),
		});
		if (creation.status !== 201) {
			throw new Error(`Manual context-pressure session creation failed with status ${creation.status}.`);
		}
		sessionId = (await creation.json()).id;
		stream = await LifecycleStream.connect(gateway, sessionId, configuredModel);
		stream.startBudget();

		const stateCursor = stream.count();
		stream.send({ type: "get_state" });
		const stateResult = await stream.waitForFrom(stateCursor, frame => {
			const model = frame.type === "state" ? frame.data?.model : undefined;
			return model?.provider === configuredModel.provider && model?.id === configuredModel.id;
		}, "exact model state");
		const runtimeModel = stateResult.frame.data.model;
		if (runtimeModel.contextWindow !== PRESSURE_CONTEXT_WINDOW) {
			throw stream.failure("RUNTIME_MODEL_FALLBACK_OR_OVERRIDE_MISMATCH", {
				runtimeProvider: runtimeModel.provider,
				runtimeModelId: runtimeModel.id,
				runtimeContextWindow: runtimeModel.contextWindow,
			});
		}
		await stream.waitForFrom(0, frame => frame.type === "session_status" && frame.status === "idle", "initial idle");

		const nonce = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
		const steerIntentId = randomUUID();
		const followIntentId = randomUUID();
		const steerFact = `STEER_ACK_${nonce}_VIOLET`;
		const followFact = `FOLLOW_ACK_${nonce}_CEDAR`;
		let compactionStartIndex = -1;
		let admittedDuringCompaction = false;
		const unsubscribe = stream.subscribe(frame => {
			if (admittedDuringCompaction || !isAutomaticCompactionStart(frame)) return;
			admittedDuringCompaction = true;
			compactionStartIndex = stream!.count() - 1;
			// Send in the same WebSocket event callback that observed start: both
			// occurrences are admitted while compaction is still the active turn.
			stream!.send({
				type: "steer",
				intentId: steerIntentId,
				text: `After the interrupted turn continues, explicitly output ${steerFact}. Do not call tools.`,
			});
			stream!.send({
				type: "prompt",
				intentId: followIntentId,
				text: `In the next turn, explicitly output both ${steerFact} and ${followFact}. Do not call tools.`,
			});
		});

		for (let round = 1; round <= MAX_PRESSURE_TURNS && !admittedDuringCompaction; round++) {
			// Reserve the ordinary turn plus a possible automatic compaction model
			// call. Once compaction starts, the remaining two slots are reserved for
			// the correlated continuation/new-turn delivery under test.
			stream.assertRequestCapacity(2, `pressure-turn-${round}`);
			const cursor = stream.count();
			stream.send({ type: "prompt", intentId: randomUUID(), text: pressurePrompt(round) });
			await stream.waitForFrom(
				cursor,
				frame => isAutomaticCompactionStart(frame) || isFinalAgentEnd(frame),
				`pressure turn ${round} compaction-or-terminal`,
			);
		}
		unsubscribe();

		if (!admittedDuringCompaction || compactionStartIndex < 0) {
			throw stream.failure("CONTEXT_PRESSURE_COMPACTION_NOT_OBSERVED", {
				pressureTurns: MAX_PRESSURE_TURNS,
				requiredReason: ["threshold", "overflow"],
			});
		}

		const compactionEnd = await stream.waitForFrom(compactionStartIndex, isCompactionEnd, "automatic compaction end");
		const compactionEvent = eventOf(compactionEnd.frame)!;
		if (compactionEvent.aborted || compactionEvent.errorMessage) {
			throw stream.failure("CONTEXT_PRESSURE_COMPACTION_FAILED", {
				reason: compactionEvent.reason,
				aborted: !!compactionEvent.aborted,
				hasError: !!compactionEvent.errorMessage,
				willRetry: compactionEvent.willRetry,
			});
		}

		const steerStart = await stream.waitForFrom(compactionStartIndex, frame =>
			eventType(frame) === "message_start"
			&& roleOfEvent(frame) === "user"
			&& deliveryIntentId(frame) === steerIntentId,
		"correlated steer user start");
		const followStart = await stream.waitForFrom(compactionStartIndex, frame =>
			eventType(frame) === "message_start"
			&& roleOfEvent(frame) === "user"
			&& deliveryIntentId(frame) === followIntentId,
		"correlated follow-up user start");
		const lastUserStartIndex = Math.max(steerStart.index, followStart.index);
		const finalEnd = await stream.waitForFrom(lastUserStartIndex, isFinalAgentEnd, "final non-retry agent end");

		const liveSteerStarts = stream.frames.filter((frame, index) =>
			index >= compactionStartIndex
			&& eventType(frame) === "message_start"
			&& roleOfEvent(frame) === "user"
			&& deliveryIntentId(frame) === steerIntentId).length;
		const liveFollowStarts = stream.frames.filter((frame, index) =>
			index >= compactionStartIndex
			&& eventType(frame) === "message_start"
			&& roleOfEvent(frame) === "user"
			&& deliveryIntentId(frame) === followIntentId).length;
		if (liveSteerStarts !== 1 || liveFollowStarts !== 1) {
			throw stream.failure("LIVE_INTENT_OCCURRENCE_COUNT_MISMATCH", {
				steerStarts: liveSteerStarts,
				followStarts: liveFollowStarts,
			});
		}

		const usefulAssistantText = stream.frames
			.slice(compactionStartIndex, finalEnd.index + 1)
			.map(assistantEndText)
			.join("\n");
		const hasSteerFact = usefulAssistantText.includes(steerFact);
		const hasFollowFact = usefulAssistantText.includes(followFact);
		if (!hasSteerFact || !hasFollowFact) {
			throw stream.failure("POST_COMPACTION_OUTPUT_NOT_USEFUL", { hasSteerFact, hasFollowFact });
		}

		const snapshotCursor = stream.count();
		stream.send({ type: "get_messages" });
		const snapshotFrame = (await stream.waitForFrom(snapshotCursor, frame => frame.type === "messages", "settled transcript snapshot")).frame;
		const snapshotMessages = Array.isArray(snapshotFrame.data) ? snapshotFrame.data : [];
		const snapshotSteerCount = snapshotIntentCount(snapshotMessages, steerIntentId);
		const snapshotFollowCount = snapshotIntentCount(snapshotMessages, followIntentId);
		if (snapshotSteerCount !== 1 || snapshotFollowCount !== 1) {
			throw stream.failure("TRANSCRIPT_INTENT_OCCURRENCE_COUNT_MISMATCH", {
				steerRows: snapshotSteerCount,
				followRows: snapshotFollowCount,
			});
		}

		// A fresh attachment is the authoritative reload/reconnect projection.
		const outbox = await readAttachOutbox(gateway, sessionId);
		const stranded = outbox
			.map(outboxRowId)
			.filter(id => id === steerIntentId || id === followIntentId);
		if (stranded.length !== 0) {
			throw stream.failure("SETTLED_INTENT_STRANDED_IN_OUTBOX", { strandedIntentIds: stranded });
		}

		// A server round trip after the settled snapshot is the negative-duplicate
		// barrier; no arbitrary quiet-period sleep is used.
		const barrierCursor = stream.count();
		stream.send({ type: "ping" });
		await stream.waitForFrom(barrierCursor, frame => frame.type === "pong", "negative duplicate barrier");
		const foreignRuntimeModel = stream.frames.find(frame => {
			const model = frame.type === "state" ? frame.data?.model : undefined;
			return model && (model.provider !== configuredModel.provider || model.id !== configuredModel.id);
		});
		if (foreignRuntimeModel) {
			throw stream.failure("RUNTIME_MODEL_FALLBACK_OBSERVED", {
				observedProvider: foreignRuntimeModel.data?.model?.provider,
				observedModelId: foreignRuntimeModel.data?.model?.id,
			});
		}
		const postBarrierSteerStarts = stream.frames.filter(frame =>
			eventType(frame) === "message_start" && roleOfEvent(frame) === "user" && deliveryIntentId(frame) === steerIntentId).length;
		const postBarrierFollowStarts = stream.frames.filter(frame =>
			eventType(frame) === "message_start" && roleOfEvent(frame) === "user" && deliveryIntentId(frame) === followIntentId).length;
		if (postBarrierSteerStarts !== 1 || postBarrierFollowStarts !== 1) {
			throw stream.failure("LATE_DUPLICATE_AFTER_FINAL_END", {
				steerStarts: postBarrierSteerStarts,
				followStarts: postBarrierFollowStarts,
			});
		}
	} finally {
		try {
			if (stream) stream.send({ type: "abort" });
		} catch {}
		stream?.close();
		await bestEffortCleanup(gateway, sessionId);
		if (gateway) await stopGateway(gateway);
		rmSync(dir, { recursive: true, force: true });
	}
});

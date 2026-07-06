import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { redactSensitive } from "../src/server/auth/redact.js";
import { sanitizeModelErrorForLog, sanitizeModelErrorText } from "../src/server/agent/model-error-sanitizer.js";
import { applyModelString, type ReviewModelRpc } from "../src/server/agent/review-model-override.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SESSION_SETUP_SOURCE = path.join(PROJECT_ROOT, "src/server/agent/session-setup.ts");

const API_KEY = "sk-or-" + "a".repeat(28);
const BEARER = "bearer_secret_" + "b".repeat(40);

function captureConsole(method: "error" | "warn") {
	const original = console[method];
	const lines: string[] = [];
	(console as any)[method] = (...args: unknown[]) => {
		lines.push(args.map((arg) => arg instanceof Error ? (arg.stack || arg.message) : String(arg)).join(" "));
	};
	return {
		lines,
		restore: () => { (console as any)[method] = original; },
	};
}

function assertRedacted(text: string) {
	assert.equal(text.includes(API_KEY), false, "API key must be redacted");
	assert.equal(text.includes(BEARER), false, "bearer token must be redacted");
	assert.match(text, /<redacted-(?:api-key|token)>/, "redaction marker should remain visible");
}

function extractFunctionBody(src: string, marker: string): string {
	const markerIndex = src.indexOf(marker);
	assert.ok(markerIndex >= 0, `could not find ${marker}`);
	const open = src.indexOf("{", markerIndex);
	assert.ok(open > markerIndex, `could not find opening brace for ${marker}`);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		if (ch === "}") depth--;
		if (depth === 0) return src.slice(open + 1, i);
	}
	throw new Error(`could not find closing brace for ${marker}`);
}

function loadHandleSetupFailure(): (session: any, plan: any, error: Error, ctx: any) => void {
	const src = readFileSync(SESSION_SETUP_SOURCE, "utf-8");
	let body = extractFunctionBody(src, "export function handleSetupFailure(");
	body = stripTypesForEval(body);
	const emitSessionEvent = (session: any, event: unknown) => {
		session.eventBuffer.push(event);
	};
	const broadcastStatus = (session: any, status: string) => {
		session.status = status;
	};
	const isWorktreePathReferencedByLiveSession = () => false;
	const cleanupWorktree = async () => {};
	return new Function(
		"sanitizeModelErrorText",
		"sanitizeModelErrorForLog",
		"emitSessionEvent",
		"broadcastStatus",
		"isWorktreePathReferencedByLiveSession",
		"cleanupWorktree",
		`return function handleSetupFailure(session, plan, error, ctx) {${body}\n};`,
	)(
		sanitizeModelErrorText,
		sanitizeModelErrorForLog,
		emitSessionEvent,
		broadcastStatus,
		isWorktreePathReferencedByLiveSession,
		cleanupWorktree,
	);
}

function stripTypesForEval(body: string): string {
	return body
		.replace(/\s+as\s+any/g, "")
		.replace(/\s+as\s+string\s*\|\s*undefined/g, "")
		.replace(/\s*:\s*unknown/g, "");
}

function loadTryAutoSelectModel(): (this: any, session: any) => Promise<void> {
	const src = readFileSync(path.join(PROJECT_ROOT, "src/server/agent/session-models.ts"), "utf-8");
	let body = extractFunctionBody(src, "async tryAutoSelectModel(session: SessionInfo)");
	body = stripTypesForEval(body).replace(/SessionModels\.AIGW_CACHE_TTL_MS/g, "60_000");
	const applyModelString = async (_rpc: any, modelString: string) => {
		throw new Error(`provider rejected ${modelString}: api_key=${API_KEY}; Authorization: Bearer ${BEARER}; cause=provider unavailable`);
	};
	const isSessionSelectableModelString = (value: unknown) => typeof value === "string" && /^[^/]+\/.+/.test(value);
	const getAigwUrl = () => undefined;
	const discoverAigwModels = async () => [];
	const selectAigwModelForRoleTier = (models: { id: string }[]) => models[0];
	const inferMeta = () => ({ reasoning: false });
	const broadcast = () => {};
	// Minimal stand-in for session-runtime.ts::resolveSessionRuntime — every
	// fixture here uses a role/fallback model failure path, never a
	// "claude-code"-provider model, so this only needs the non-"claude-code"
	// default.
	const resolveSessionRuntime = (opts: { runtime?: string; modelProvider?: string }) => (
		opts.runtime ?? (opts.modelProvider === "claude-code" ? "claude-code" : "pi")
	);
	return new Function(
		"applyModelString",
		"isSessionSelectableModelString",
		"getAigwUrl",
		"discoverAigwModels",
		"selectAigwModelForRoleTier",
		"inferMeta",
		"sanitizeModelErrorText",
		"sanitizeModelErrorForLog",
		"broadcast",
		"resolveSessionRuntime",
		`return async function tryAutoSelectModel(session) {${body}\n};`,
	)(
		applyModelString,
		isSessionSelectableModelString,
		getAigwUrl,
		discoverAigwModels,
		selectAigwModelForRoleTier,
		inferMeta,
		sanitizeModelErrorText,
		sanitizeModelErrorForLog,
		broadcast,
		resolveSessionRuntime,
	);
}

describe("model setup error redaction", () => {
	it("redactSensitive masks API-key assignments, bearer headers, and prefixed keys", () => {
		const safe = redactSensitive(`provider rejected api_key=${API_KEY}; Authorization: Bearer ${BEARER}; token=${BEARER}`);
		assertRedacted(safe);
		assert.match(safe, /provider rejected/);
	});

	it("handleSetupFailure emits redacted assistant content and errorMessage", () => {
		const err = new Error(`setModel rejected: api_key=${API_KEY}; Authorization: Bearer ${BEARER}; cause=provider unavailable`);
		const buffered: unknown[] = [];
		const session: any = {
			id: "setup-redaction-session",
			status: "preparing",
			statusVersion: 0,
			clients: new Set(),
			eventBuffer: { push: (event: unknown) => buffered.push(event) },
			unsubscribe: () => {},
			rpcClient: { stop: async () => {} },
		};
		const plan = { id: session.id, mode: "normal" };
		const archived: string[] = [];
		const removedSecrets: string[] = [];
		const ctx = {
			sessions: new Map([[session.id, session]]),
			store: { archive: (id: string) => archived.push(id), getAll: () => [] },
			sessionSecretStore: { remove: (id: string) => removedSecrets.push(id) },
		};
		const captured = captureConsole("error");
		try {
			loadHandleSetupFailure()(session, plan, err, ctx);
		} finally {
			captured.restore();
		}

		const event = buffered[0] as any;
		const emittedText = event?.message?.content?.[0]?.text ?? "";
		const emittedError = event?.message?.errorMessage ?? "";
		assert.match(emittedText, /Session setup failed: .*provider unavailable/);
		assert.match(emittedError, /provider unavailable/);
		assertRedacted(emittedText);
		assertRedacted(emittedError);
		assertRedacted(captured.lines.join("\n"));
		assert.deepEqual(archived, [session.id]);
		assert.deepEqual(removedSecrets, [session.id]);
	});

	it("session-manager controlled fallback errors and logs redact provider secrets", async () => {
		const captured = captureConsole("warn");
		let thrown: unknown;
		try {
			await loadTryAutoSelectModel().call({
				preferencesStore: {
					get(key: string) {
						return ({ allowSessionModelFallback: true, "default.sessionModel": "openai/dead-fallback" } as Record<string, unknown>)[key];
					},
				},
				resolveRoleModel: () => "anthropic/dead-role",
				resolveRoleThinkingLevel: () => undefined,
				resolveStoreForSession: () => ({ get: () => undefined, update: () => {} }),
				_writeModelNameFile: () => {},
				broadcast: () => {},
			}, {
				id: "session-manager-redaction",
				role: "coder",
				clients: new Set(),
				rpcClient: {},
			});
		} catch (err) {
			thrown = err;
		} finally {
			captured.restore();
		}

		assert.ok(thrown instanceof Error);
		assert.match(thrown.message, /role model "anthropic\/dead-role" failed/);
		assert.match(thrown.message, /provider unavailable/);
		assertRedacted(thrown.message);
		assertRedacted(captured.lines.join("\n"));
	});

	it("review model override errors and fallback logs redact provider secrets", async () => {
		const captured = captureConsole("warn");
		const calls: string[] = [];
		const rpc: ReviewModelRpc = {
			async setModel(provider: string, modelId: string) {
				calls.push(`${provider}/${modelId}`);
				throw new Error(`provider rejected ${provider}/${modelId}: api_key=${API_KEY}; Authorization: Bearer ${BEARER}; cause=stale model`);
			},
			async getState() {
				return { model: { provider: "unset", id: "unset" } };
			},
		};

		let thrown: unknown;
		try {
			await applyModelString(rpc, "anthropic/dead-selected", {
				contextLabel: "role.coder.model",
				maxAttempts: 1,
				retryDelayMs: 0,
				controlledFallback: { enabled: true, model: "openai/dead-fallback" },
			});
		} catch (err) {
			thrown = err;
		} finally {
			captured.restore();
		}

		assert.ok(thrown instanceof Error);
		assert.match(thrown.message, /controlled model fallback failed/);
		assert.match(thrown.message, /stale model/);
		assertRedacted(thrown.message);
		assertRedacted(captured.lines.join("\n"));
		assert.deepEqual(calls, ["anthropic/dead-selected", "openai/dead-fallback"]);
	});

	it("review model override hard-fail path redacts setModel errors", async () => {
		const rpc: ReviewModelRpc = {
			async setModel() {
				throw new Error(`setModel leaked Bearer ${BEARER} and ${API_KEY}`);
			},
			async getState() {
				return { model: { provider: "unset", id: "unset" } };
			},
		};

		await assert.rejects(
			() => applyModelString(rpc, "anthropic/dead-selected", { maxAttempts: 1, retryDelayMs: 0 }),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /setModel failed/);
				assertRedacted(err.message);
				return true;
			},
		);
	});
});

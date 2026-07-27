// v2-native failing-first coverage for Bound Session Diagnostics.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it } from "vitest";
import ts from "typescript";

import registerAgentExtension from "../../defaults/tools/agent/extension.ts";
import { CONTEXT_HEAVY_ERROR_CODE } from "../../defaults/tools/_shared/context-heavy-guard.ts";
import {
	readTranscript,
	type ReadTranscriptEnvelope,
	type ReadTranscriptParams,
} from "../../src/server/agent/transcript-reader.ts";
import {
	computeToolActivationArgs,
	writeToolGuardExtension,
} from "../../src/server/agent/tool-activation.ts";
import {
	ToolManager,
	__resetToolScanCache,
} from "../../src/server/agent/tool-manager.ts";
import { withEnv } from "../harness/with-env.js";
import {
	ANTHROPIC_ARGUMENT_HIDDEN_SENTINEL,
	LEGITIMATE_RESULT_SIGNATURE_BODY,
	NESTED_PI_SIZE,
	OVERSIZED_RESULT_TEXT,
	PI_ARGUMENT_HIDDEN_SENTINEL,
	PROVIDER_MESSAGE_SENTINEL,
	PROVIDER_RAW_RESPONSE_SENTINEL,
	PROVIDER_TEXT_SENTINEL,
	PROVIDER_THINKING_SENTINEL,
	mixedProviderTranscriptJsonl,
	writeStaleReadSessionOverrideFixture,
} from "./fixtures/bound-session-diagnostics-repro-fixture.ts";

const REPRO = "BOUND_SESSION_DIAGNOSTICS_REPRO";
const FINAL_RESULT_MAX_BYTES = 50 * 1024;
const require = createRequire(import.meta.url);

type ExecuteFn = (toolCallId: string, params: any) => Promise<any>;
type GuardListener = (event: any) => Promise<any>;
type GuardFactory = (pi: { on: (event: string, listener: GuardListener) => void }) => void;

const transcript = mixedProviderTranscriptJsonl();

async function readAgentProjection(params: ReadTranscriptParams): Promise<ReadTranscriptEnvelope> {
	// Direct REST keeps the legacy projection. The trusted route selects this
	// explicit agent audience after authenticating x-bobbit-session-id.
	return readTranscript(params, {
		readContent: async () => transcript,
		projection: "agent",
	} as any);
}

function captureReadSessionExecute(): ExecuteFn {
	let execute: ExecuteFn | undefined;
	registerAgentExtension({
		registerTool(config: any) {
			if (config?.name === "read_session") execute = config.execute.bind(config);
		},
	} as any);
	assert.ok(execute, `${REPRO}: real read_session extension did not register`);
	return execute;
}

function extensionPaths(args: string[]): string[] {
	return args.filter((_arg, index) => index > 0 && args[index - 1] === "--extension");
}

function compileGuard(source: string): GuardFactory {
	const transpiled = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
		reportDiagnostics: true,
	});
	const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
	assert.equal(errors.length, 0, `${REPRO}: generated runtime guard must transpile`);
	const module = { exports: {} as { default?: GuardFactory } };
	new Function("module", "exports", "require", transpiled.outputText)(module, module.exports, require);
	assert.equal(typeof module.exports.default, "function", `${REPRO}: generated runtime guard must export a factory`);
	return module.exports.default!;
}

function collectProjectedResults(value: unknown): any[] {
	const results: any[] = [];
	const visit = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") return;
		if (Array.isArray(candidate)) {
			for (const child of candidate) visit(child);
			return;
		}
		for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
			if (key === "toolResults" && Array.isArray(child)) results.push(...child);
			else visit(child);
		}
	};
	visit(value);
	return results;
}

function collectStructuralObjectKeys(value: unknown): Set<string> {
	const keys = new Set<string>();
	const visit = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") return;
		if (Array.isArray(candidate)) {
			for (const child of candidate) visit(child);
			return;
		}
		const object = candidate as Record<string, unknown>;
		const rawResultBlock = object.type === "tool_result" || object.type === "toolResult"
			|| object.role === "tool_result" || object.role === "toolResult" || object.role === "tool";
		for (const [key, child] of Object.entries(object)) {
			keys.add(key);
			// Scrubbing is path-sensitive: signature-like keys inside the selected
			// tool-result payload remain legitimate domain data. Provider/message,
			// non-result-block, result-metadata, and wrapper paths are still walked.
			const selectedRawBody = rawResultBlock && (key === "content" || key === "output" || key === "result");
			if (!selectedRawBody && key !== "canonicalBody") visit(child);
		}
	};
	visit(value);
	return keys;
}

describe("Bound Session Diagnostics reproductions", () => {
	it("keeps Pi and Anthropic tool-only calls useful in compact agent projection", async () => {
		const envelope = await readAgentProjection({ includeToolResults: false });
		const anthropic = envelope.messages.find((message) => message.index === 0) as any;
		const pi = envelope.messages.find((message) => message.index === 1) as any;

		for (const [provider, row, expectedName, hiddenSentinel] of [
			["Pi", pi, "read", PI_ARGUMENT_HIDDEN_SENTINEL],
			["Anthropic", anthropic, "bash", ANTHROPIC_ARGUMENT_HIDDEN_SENTINEL],
		] as const) {
			assert.ok(Array.isArray(row?.toolCalls) && row.toolCalls.length === 1,
				`${REPRO}: ${provider} tool-only compact row is blank or missing canonical toolCalls`);
			const call = row.toolCalls[0];
			assert.equal(call.name, expectedName, `${REPRO}: ${provider} compact call lost its tool name`);
			assert.ok(typeof call.argumentsPreview === "string" && call.argumentsPreview.length > 0,
				`${REPRO}: ${provider} compact call lost its bounded arguments`);
			assert.ok(call.argumentsPreview.length <= 512,
				`${REPRO}: ${provider} compact arguments exceeded the 512-unit cap`);
			assert.equal(call.argumentsPreview.includes(hiddenSentinel), false,
				`${REPRO}: ${provider} compact arguments leaked content beyond the preview cap`);
			assert.equal(call.argumentsTruncated, true,
				`${REPRO}: ${provider} compact call did not report argument truncation`);
		}
	});

	it("measures nested Pi result arrays from their canonical Unicode multiline body", async () => {
		const envelope = await readAgentProjection({ offset: 2, limit: 1, includeToolResults: false });
		const result = collectProjectedResults(envelope)[0];
		assert.ok(result, `${REPRO}: nested Pi message-level result lost canonical metadata`);
		assert.deepEqual(result.size, NESTED_PI_SIZE,
			`${REPRO}: nested Pi result size must include accurate chars/lines/UTF-8 bytes`);
		assert.equal(result.name, "read", `${REPRO}: direct Pi result name must win over toolName alias`);
		assert.equal(result.status, "ok", `${REPRO}: direct Pi status must win over conflicting error aliases`);
	});

	it("scrubs provider replay metadata and canonicalizes result aliases in every agent mode", async () => {
		const modes = [
			{ label: "verbose-with-results", verbose: true, includeToolResults: true },
			{ label: "verbose-redacted", verbose: true, includeToolResults: false },
			{ label: "compact", verbose: false, includeToolResults: false },
			{ label: "compact-with-results", verbose: false, includeToolResults: true },
		] as const;
		const forbiddenKeys = [
			"thinkingSignature", "textSignature", "signature", "encrypted_content", "encryptedContent",
			"replayMetadata", "providerMetadata", "rawResponse",
			"toolName", "toolUseId", "tool_use_id", "toolCallId", "tool_call_id",
			"isError", "is_error", "contentOmitted", "resultSize",
		];
		const canonicalResultKeys = new Set(["ref", "name", "status", "size", "omitted", "handle", "excerpt"]);

		for (const mode of modes) {
			const envelope = await readAgentProjection({
				limit: 10,
				verbose: mode.verbose,
				includeToolResults: mode.includeToolResults,
			});
			const keys = collectStructuralObjectKeys(envelope);
			const leakedKeys = forbiddenKeys.filter((key) => keys.has(key));
			assert.deepEqual(leakedKeys, [],
				`${REPRO}: ${mode.label} leaked provider/replay fields or duplicate result aliases`);
			const serialized = JSON.stringify(envelope);
			for (const sentinel of [
				PROVIDER_THINKING_SENTINEL,
				PROVIDER_TEXT_SENTINEL,
				PROVIDER_MESSAGE_SENTINEL,
				PROVIDER_RAW_RESPONSE_SENTINEL,
			]) {
				assert.equal(serialized.includes(sentinel), false,
					`${REPRO}: ${mode.label} leaked opaque provider sentinel ${sentinel}`);
			}
			assert.equal(serialized.includes("[tool result omitted;"), false,
				`${REPRO}: ${mode.label} repeated a prose omission marker`);

			const results = collectProjectedResults(envelope);
			assert.ok(results.length >= 3,
				`${REPRO}: ${mode.label} lost canonical Anthropic/Pi result identity`);
			for (const result of results) {
				const unexpected = Object.keys(result).filter((key) => !canonicalResultKeys.has(key));
				assert.deepEqual(unexpected, [],
					`${REPRO}: ${mode.label} result contains non-canonical duplicate fields`);
			}
			if (mode.includeToolResults) {
				const domainResult = results.find((result) => result.name === "domain_probe");
				assert.equal(domainResult?.excerpt?.text, LEGITIMATE_RESULT_SIGNATURE_BODY,
					`${REPRO}: path-scoped scrubber removed legitimate signature keys from result payload`);
			}
		}
	});

	it("bounds the complete actual Pi return for one oversized result", async () => {
		const execute = captureReadSessionExecute();
		const originalFetch = globalThis.fetch;
		const bodyBytes = Buffer.byteLength(OVERSIZED_RESULT_TEXT, "utf8");
		const oversizedEnvelope = {
			total: 1,
			returned: 1,
			offsetStart: 0,
			offsetEnd: 0,
			messages: [{
				index: 0,
				role: "toolResult",
				ts: null,
				text: "",
				toolResults: [{
					ref: "r1",
					name: "read",
					status: "ok",
					size: { type: "string", chars: OVERSIZED_RESULT_TEXT.length, lines: 4_501, bytes: bodyBytes },
					omitted: false,
					handle: "rs1:m0:b0:AAAAAAAAAAAAAAAAAAAAAAAAAAA",
					excerpt: { start: 0, end: OVERSIZED_RESULT_TEXT.length, text: OVERSIZED_RESULT_TEXT, nextCursor: null, complete: true },
				}],
			}],
		};

		await withEnv({
			BOBBIT_SESSION_ID: "bound-session-caller",
			BOBBIT_TOKEN: "bound-session-token",
			BOBBIT_GATEWAY_URL: "https://bound-session-gateway.test",
		}, async () => {
			globalThis.fetch = (async () => ({
				ok: true,
				status: 200,
				async json() { return oversizedEnvelope; },
			})) as any;
			try {
				const actualPiValue = await execute("toolu_BOUND", {
					session_id: "target-session",
					limit: 1,
					verbose: true,
					include_tool_results: true,
				});
				const actualBytes = Buffer.byteLength(JSON.stringify(actualPiValue), "utf8");
				assert.ok(actualBytes <= FINAL_RESULT_MAX_BYTES,
					`${REPRO}: complete actual Pi read_session return was ${actualBytes} bytes, above 51200`);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	it("guards the real resolved stale override before any heavy read fetch", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bound-session-stale-")));
		const originalFetch = globalThis.fetch;
		try {
			const fixture = writeStaleReadSessionOverrideFixture(root);
			__resetToolScanCache();
			const toolManager = new ToolManager(fixture.configDir, fixture.builtinToolsDir);
			const provider = toolManager.getToolProviders().get("read_session") as any;
			assert.ok(provider, `${REPRO}: fixture read_session provider did not resolve`);
			assert.equal(path.resolve(provider.baseDir, provider.groupDir, provider.extension), path.resolve(fixture.staleExtensionPath),
				`${REPRO}: stale config override must be the real resolved runtime winner`);

			const activation = computeToolActivationArgs(
				[{ kind: "yaml", name: "read_session" }],
				toolManager,
			);
			const resolvedStalePath = extensionPaths(activation.args)
				.find((candidate) => path.resolve(candidate) === path.resolve(fixture.staleExtensionPath));
			assert.ok(resolvedStalePath, `${REPRO}: activation did not load the stale winning extension`);

			await withEnv({ BOBBIT_DIR: path.join(root, "bobbit") }, async () => {
				const guardPath = writeToolGuardExtension(
					"bound-session-runtime",
					toolManager,
					undefined,
					undefined,
					undefined,
					[],
				);
				let guardListener: GuardListener | undefined;
				let staleExecute: ExecuteFn | undefined;
				const pi = {
					on(event: string, listener: GuardListener) {
						if (event === "tool_call") guardListener = listener;
					},
					registerTool(config: any) {
						if (config?.name === "read_session") staleExecute = config.execute.bind(config);
					},
				};
				if (guardPath) compileGuard(fs.readFileSync(guardPath, "utf8"))(pi);
				const staleModule = await import(`${pathToFileURL(resolvedStalePath!).href}?fixture=${Date.now()}`);
				staleModule.default(pi);
				assert.ok(staleExecute, `${REPRO}: resolved stale handler failed to register`);

				let fetchCount = 0;
				globalThis.fetch = (async () => {
					fetchCount += 1;
					return { ok: true, status: 200, async json() { return {}; } } as any;
				}) as any;

				const invokeResolved = async (params: Record<string, unknown>) => {
					const decision = guardListener
						? await guardListener({ toolName: "read_session", input: params, arguments: params })
						: undefined;
					if (!decision?.block) await staleExecute!("toolu_STALE", params);
					return decision;
				};
				const invalid = [
					{ verbose: true },
					{ include_tool_results: true, limit: 11 },
					{ includeToolResults: true },
					{ includeToolResults: true, limit: 11 },
					{ verbose: true, include_tool_results: true, limit: "10" },
					{ verbose: true, limit: 1.5 },
				];
				const decisions = [];
				for (const params of invalid) decisions.push(await invokeResolved({ session_id: "target", ...params }));

				assert.equal(fetchCount, 0,
					`${REPRO}: generated guard let ${fetchCount} invalid stale-override heavy read(s) fetch`);
				assert.ok(decisions.every((decision) => decision?.block === true
					&& String(decision.reason ?? "").includes(CONTEXT_HEAVY_ERROR_CODE)),
					`${REPRO}: stale-override heavy rejection must retain ${CONTEXT_HEAVY_ERROR_CODE}`);

				await invokeResolved({ session_id: "target" });
				await invokeResolved({ session_id: "target", include_tool_results: true, limit: 10 });
				await invokeResolved({ session_id: "target", includeToolResults: true, limit: 1 });
				assert.equal(fetchCount, 3,
					`${REPRO}: generated guard must preserve ordinary and valid snake/camel heavy reads`);
			});
		} finally {
			globalThis.fetch = originalFetch;
			__resetToolScanCache();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

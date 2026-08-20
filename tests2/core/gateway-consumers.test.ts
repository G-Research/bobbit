// v2-native — multi-gateway consumer contracts.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { getAvailableModels, invalidateModelCache, type ApiModel } from "../../src/server/agent/model-registry.js";
import { SessionManager, gatewayModelBinding } from "../../src/server/agent/session-manager.js";
import { generateGoalSummaryTitle, generateSessionTitle } from "../../src/server/agent/title-generator.js";
import { GatewayCredentialResolutionError, type ModelGateway } from "../../src/server/agent/aigw-manager.js";
import { completeModelText } from "../../src/server/agent/model-completion.js";

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function gateway(name: string, url: string, type: ModelGateway["type"] = "openai-compatible"): ModelGateway {
	return { id: `id-${name}`, name, url, type, enabled: true };
}

function startTitleGateway(requiredToken?: string, completionFailure?: { status: number; body: string }): Promise<{
	url: string;
	getRequests: () => Array<{ path: string; authorization: string | undefined }>;
	close: () => Promise<void>;
}> {
	const requests: Array<{ path: string; authorization: string | undefined }> = [];
	const server = http.createServer((req, res) => {
		requests.push({ path: req.url || "", authorization: req.headers.authorization });
		if (req.url === "/.well-known/opencode") {
			res.writeHead(404); res.end(); return;
		}
		if (req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "claude-haiku-local" }] })); return;
		}
		if (req.url === "/v1/chat/completions") {
			if (requiredToken && req.headers.authorization !== `Bearer ${requiredToken}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "missing authorization" })); return;
			}
			if (completionFailure) {
				res.writeHead(completionFailure.status, { "Content-Type": "application/json" });
				res.end(completionFailure.body); return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { content: "<title>Authenticated Gateway</title>" }, finish_reason: "stop" }] })); return;
		}
		res.writeHead(404); res.end();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
		const port = (server.address() as { port: number }).port;
		resolve({
			url: `http://127.0.0.1:${port}`,
			getRequests: () => [...requests],
			close: () => new Promise<void>((done) => server.close(() => done())),
		});
	}));
}

function captureConsoleErrors(): { lines: string[]; restore: () => void } {
	const original = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
	return { lines, restore: () => { console.error = original; } };
}

function startStreamingTitleGateway(requiredToken?: string): Promise<{
	url: string;
	getAuthorizationHeaders: () => Array<string | undefined>;
	close: () => Promise<void>;
}> {
	const authorizationHeaders: Array<string | undefined> = [];
	const server = http.createServer((req, res) => {
		if (req.url !== "/v1/chat/completions") {
			res.writeHead(404); res.end(); return;
		}
		let requestBody = "";
		authorizationHeaders.push(req.headers.authorization);
		req.on("data", (chunk) => { requestBody += chunk; });
		req.on("end", () => {
			assert.equal(JSON.parse(requestBody).stream, true, "the real Pi completion path must request a stream");
			if (requiredToken && req.headers.authorization !== `Bearer ${requiredToken}`) {
				res.writeHead(401); res.end(); return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "<title>Anonymous Gateway</title>" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
		const port = (server.address() as { port: number }).port;
		resolve({
			url: `http://127.0.0.1:${port}`,
			getAuthorizationHeaders: () => [...authorizationHeaders],
			close: () => new Promise((done) => server.close(() => done())),
		});
	}));
}

function startGateway(requiredToken?: string): Promise<{
	url: string;
	setAvailable: (available: boolean) => void;
	getModelRequests: () => number;
	getAuthorizationHeaders: () => Array<string | undefined>;
	close: () => Promise<void>;
}> {
	let available = true;
	let modelRequests = 0;
	const authorizationHeaders: Array<string | undefined> = [];
	const server = http.createServer((req, res) => {
		if (req.url === "/v1/models") {
			modelRequests++;
			authorizationHeaders.push(req.headers.authorization);
			if (requiredToken && req.headers.authorization !== `Bearer ${requiredToken}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "missing authorization" }));
				return;
			}
			if (!available) {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "temporarily unavailable" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "claude-local" }] }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
		const port = (server.address() as { port: number }).port;
		resolve({
			url: `http://127.0.0.1:${port}`,
			setAvailable: (next) => { available = next; },
			getModelRequests: () => modelRequests,
			getAuthorizationHeaders: () => [...authorizationHeaders],
			close: () => new Promise<void>((done) => server.close(() => done())),
		});
	}));
}

describe("multi-gateway consumers", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gateway-consumers-"));
		process.env.BOBBIT_AGENT_DIR = agentDir;
		resetAgentDirStateForTests();
		invalidateModelCache();
	});

	afterEach(() => {
		invalidateModelCache();
		if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
		resetAgentDirStateForTests();
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("keeps retained availability scoped to the named gateway and normalized endpoint", async () => {
		const service = await startGateway();
		try {
			service.setAvailable(false);
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("modelGateways", [gateway("local-a", service.url)]);
			fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
				providers: {
					"local-a": {
						baseUrl: `${service.url}/v1`, api: "openai-completions", apiKey: "none",
						models: [{ id: "retained-local", name: "Retained local", api: "openai-completions", baseUrl: `${service.url}/v1`, contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST }],
					},
				},
			}));

			const retained = await getAvailableModels(prefs);
			assert.ok(retained.some((model) => model.provider === "local-a" && model.id === "retained-local"));

			prefs.set("modelGateways", [gateway("local-b", service.url)]);
			invalidateModelCache();
			const renamed = await getAvailableModels(prefs);
			assert.equal(renamed.some((model) => model.provider === "local-b" && model.id === "retained-local"), false);
		} finally {
			await service.close();
		}
	});

	it("keeps only same-origin retained models selectable after a gateway key is added", async () => {
		const service = await startGateway();
		try {
			service.setAvailable(false);
			const registered = gateway("aigw", service.url, "aigw");
			const prefs = new PreferencesStore(path.join(agentDir, "retained-origin-state"));
			prefs.set("modelGateways", [registered]);
			prefs.set(`providerKey.gateway.${registered.id}`, "gateway-secret");
			fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
				providers: {
					[registered.name]: {
						baseUrl: service.url,
						apiKey: "none",
						api: "openai-completions",
						models: [
							{ id: "same-origin", name: "Same origin", api: "openai-completions", baseUrl: `${service.url}/v1`, contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST },
							{ id: "foreign-retained", name: "Foreign retained", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST },
						],
					},
				},
			}));

			const models = await getAvailableModels(prefs);
			assert.ok(models.some((model) => model.provider === registered.name && model.id === "same-origin"));
			assert.equal(
				models.some((model) => model.provider === registered.name && model.id === "foreign-retained"),
				false,
				"an outage must not re-offer an anonymously retained foreign endpoint after adding a gateway key",
			);
		} finally {
			await service.close();
		}
	});

	it("resolves credentials for registry and session discovery, then fails closed on command errors", async () => {
		const service = await startGateway("consumer-token");
		try {
			const registered = gateway("credentialed", service.url);
			const prefs = new PreferencesStore(path.join(agentDir, "credential-state"));
			prefs.set("modelGateways", [registered]);
			prefs.set(`providerKey.gateway.${registered.id}`, "consumer-token");

			const registryModels = await getAvailableModels(prefs);
			assert.ok(registryModels.some((model) => model.provider === registered.name && model.id === "claude-local"));

			const manager: any = new SessionManager({ preferencesStore: prefs, stateDir: path.join(agentDir, "credential-session-state") });
			await manager.discoverGatewayModelsCached(registered);
			assert.deepEqual(service.getAuthorizationHeaders(), ["Bearer consumer-token", "Bearer consumer-token"]);

			prefs.set(`providerKey.gateway.${registered.id}`, "!exit 1");
			invalidateModelCache();
			const requestCountBeforeFailure = service.getModelRequests();
			const unavailable = await getAvailableModels(prefs);
			assert.equal(unavailable.some((model) => model.provider === registered.name), false);
			await assert.rejects(manager.discoverGatewayModelsCached({ ...registered, url: `${registered.url}/changed` }), /Unable to resolve API key for gateway "credentialed"/);
			assert.equal(service.getModelRequests(), requestCountBeforeFailure, "credential command failures must not retry discovery without authorization");
		} finally {
			await service.close();
		}
	});

	it("scopes discovery caching and Pi bindings to the owning gateway provider", async () => {
		const service = await startGateway();
		try {
			const manager: any = new SessionManager({ stateDir: path.join(agentDir, "session-state") });
			const first = gateway("local-a", service.url);
			const second = gateway("local-b", service.url);
			await manager.discoverGatewayModelsCached(first);
			await manager.discoverGatewayModelsCached(first);
			await manager.discoverGatewayModelsCached(second);
			assert.equal(service.getModelRequests(), 2, "same named gateway is cached, distinct gateway names are not conflated");
			assert.equal(gatewayModelBinding(first, { id: "claude-local", wireId: "must-not-use-wire-id" }), "local-a/claude-local");
			assert.equal(gatewayModelBinding(gateway("aigw", service.url, "aigw"), { id: "aws/claude-haiku" }), "aigw/claude-haiku");
		} finally {
			await service.close();
		}
	});

	it("uses real Pi completions for anonymous named and migrated AIGW title models", async () => {
		const service = await startStreamingTitleGateway();
		try {
			for (const registered of [
				gateway("local-a", service.url),
				gateway("aigw", service.url, "aigw"),
			]) {
				const prefs = new PreferencesStore(path.join(agentDir, `anonymous-title-${registered.name}`));
				prefs.set("modelGateways", [registered]);
				const model: ApiModel = {
					id: "title-model", name: "Title model", provider: registered.name, api: "openai-completions", baseUrl: `${registered.url}/v1`,
					contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST, authenticated: true,
				};
				for (const staleGenericKey of ["stale-generic-key", undefined]) {
					if (staleGenericKey) prefs.set(`providerKey.${registered.name}`, staleGenericKey);
					else prefs.remove(`providerKey.${registered.name}`);
					fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
						providers: { [registered.name]: { apiKey: "retained-stale-key" } },
					}));
					assert.equal(await generateSessionTitle(
						[{ role: "user", content: "Use the local model without a key." }],
						{ namingModel: `${registered.name}/${model.id}`, gateways: [registered], availableModels: [model], preferencesStore: prefs },
					), "Anonymous Gateway");
				}
			}
			assert.deepEqual(
				service.getAuthorizationHeaders(),
				["Bearer none", "Bearer none", "Bearer none", "Bearer none"],
				"Pi's anonymous sentinel must not revive generic or retained credentials",
			);
		} finally {
			await service.close();
		}
	});

	it("resolves a title gateway credential command exactly once in the real completion path", async () => {
		const service = await startStreamingTitleGateway("title-command-token");
		const commandMarker = path.join(agentDir, "title-credential-command-count");
		const commandScript = path.join(agentDir, "title-credential-command.cjs");
		try {
			const registered = gateway("command-title", service.url);
			const prefs = new PreferencesStore(path.join(agentDir, "command-title-state"));
			prefs.set("modelGateways", [registered]);
			// Use a script file rather than an inline `node -e` payload: it avoids
			// shell-specific quoting while still exercising the actual command runner.
			fs.writeFileSync(commandScript, `require("node:fs").appendFileSync(${JSON.stringify(commandMarker)}, "x"); process.stdout.write("title-command-token");`);
			prefs.set(`providerKey.gateway.${registered.id}`, `!${JSON.stringify(process.execPath)} ${JSON.stringify(commandScript)}`);
			let commandCalls = 0;
			const commandRunner = {
				async execFile(_file: string, args: readonly string[]) {
					commandCalls++;
					assert.ok(args.some((arg) => arg.includes(path.basename(commandScript))), "credential command must target the temporary script");
					assert.match(fs.readFileSync(commandScript, "utf8"), /title-command-token/);
					fs.appendFileSync(commandMarker, "x");
					return { stdout: "title-command-token", stderr: "" };
				},
			};
			const model: ApiModel = {
				id: "title-model", name: "Title model", provider: registered.name, api: "openai-completions", baseUrl: `${registered.url}/v1`,
				contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST, authenticated: true,
			};

			assert.equal(await generateSessionTitle(
				[{ role: "user", content: "Resolve this credential once." }],
				{
					namingModel: `${registered.name}/${model.id}`, gateways: [registered], availableModels: [model], preferencesStore: prefs,
					modelCompletionDependencies: { commandRunner },
				},
			), "Anonymous Gateway");
			assert.equal(commandCalls, 1);
			assert.equal(fs.readFileSync(commandMarker, "utf8"), "x");
			assert.deepEqual(service.getAuthorizationHeaders(), ["Bearer title-command-token"]);
		} finally {
			await service.close();
			fs.rmSync(commandMarker, { force: true });
			fs.rmSync(commandScript, { force: true });
		}
	});

	it("keeps an outage-retained gateway anonymous after its key is cleared", async () => {
		const service = await startStreamingTitleGateway();
		try {
			const registered = gateway("retained-clear", service.url);
			const prefs = new PreferencesStore(path.join(agentDir, "retained-clear-state"));
			prefs.set("modelGateways", [registered]);
			prefs.set(`providerKey.gateway.${registered.id}`, "previous-key");
			fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
				providers: { [registered.name]: { apiKey: "previous-key" } },
			}));
			// An outage retains the prior models.json block while the user clears its key.
			prefs.remove(`providerKey.gateway.${registered.id}`);
			const model: ApiModel = {
				id: "retained-model", name: "Retained model", provider: registered.name, api: "openai-completions", baseUrl: `${registered.url}/v1`,
				contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST, authenticated: true,
			};
			assert.equal(await completeModelText(model, prefs, { systemPrompt: "test", userPrompt: "test" }), "<title>Anonymous Gateway</title>");
			assert.deepEqual(service.getAuthorizationHeaders(), ["Bearer none"]);
		} finally {
			await service.close();
		}
	});

	it("makes matching gateway rows authoritative over generic credentials and stale config commands", async () => {
		const registered = gateway("anonymous-owner", "http://127.0.0.1:1234");
		const prefs = new PreferencesStore(path.join(agentDir, "anonymous-owner-state"));
		prefs.set("modelGateways", [registered]);
		const model: ApiModel = {
			id: "anonymous-model", name: "Anonymous model", provider: registered.name, api: "openai-completions", baseUrl: `${registered.url}/v1`,
			contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST, authenticated: true,
		};
		const resolvedApiKeys: string[] = [];
		const configReads: string[] = [];
		let commandCalls = 0;
		const complete = async (_model: unknown, _context: unknown, options?: { apiKey?: string }) => {
			resolvedApiKeys.push(options?.apiKey ?? "");
			return { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } as any;
		};

		for (const [privateExpression, genericExpression, staleExpression] of [
			[undefined, "unrelated-generic-key", "retained-literal-key"],
			["", "unrelated-generic-key", "retained-literal-key"],
			["none", "", "!stale-provider-command"],
		] as const) {
			if (privateExpression === undefined) prefs.remove(`providerKey.gateway.${registered.id}`);
			else prefs.set(`providerKey.gateway.${registered.id}`, privateExpression);
			prefs.set(`providerKey.${registered.name}`, genericExpression);
			await completeModelText(model, prefs, { systemPrompt: "test", userPrompt: "test" }, complete, {
				providerConfigReader: (provider) => {
					configReads.push(provider);
					return { apiKey: staleExpression };
				},
				commandRunner: { async execFile() { commandCalls++; return { stdout: "must-not-run", stderr: "" }; } },
			});
		}

		assert.deepEqual(resolvedApiKeys, ["none", "none", "none"]);
		assert.deepEqual(configReads, [], "matching gateway rows must not read stale provider config");
		assert.equal(commandCalls, 0, "matching gateway rows must not execute stale provider config commands");
	});

	it("uses strict credentials for explicit title models and makes command failures observable", async () => {
		const named = gateway("named", "http://127.0.0.1:1234");
		const model: ApiModel = {
			id: "title-model", name: "Title model", provider: named.name, api: "openai-completions", baseUrl: `${named.url}/v1`,
			contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST, authenticated: true,
		};
		const prefs = new PreferencesStore(path.join(agentDir, "strict-title-state"));
		prefs.set("modelGateways", [named]);
		prefs.set(`providerKey.gateway.${named.id}`, "!exit 1");
		let completions = 0;
		const options = {
			namingModel: `${named.name}/${model.id}`,
			gateways: [named],
			availableModels: [model],
			preferencesStore: prefs,
			directModelCompleter: async () => { completions++; return "<title>must not run</title>"; },
		};
		await assert.rejects(
			generateSessionTitle([{ role: "user", content: "Use the secured model." }], options),
			(error: unknown) => error instanceof GatewayCredentialResolutionError && error.message === 'Unable to resolve API key for gateway "named"',
		);
		await assert.rejects(
			generateGoalSummaryTitle("Use the secured model", options),
			GatewayCredentialResolutionError,
		);
		assert.equal(completions, 0, "failed credentials must make zero title completion calls");
	});

	it("sends implicit AIGW title and summary credentials only to its configured origin and fails closed", async () => {
		const service = await startTitleGateway("title-token");
		try {
			const enterprise = gateway("aigw", service.url, "aigw");
			const prefs = new PreferencesStore(path.join(agentDir, "implicit-title-state"));
			prefs.set("modelGateways", [enterprise]);
			prefs.set(`providerKey.gateway.${enterprise.id}`, "title-token");
			const options = { gateways: [enterprise], aigwGateway: enterprise, preferencesStore: prefs };
			assert.equal(await generateSessionTitle([{ role: "user", content: "Give this a secure title." }], options), "Authenticated Gateway");
			assert.equal(await generateGoalSummaryTitle("Give this goal a secure title", options), "Authenticated Gateway");
			const gatewayRequests = service.getRequests().filter((request) => request.path.startsWith("/v1/"));
			assert.ok(gatewayRequests.length >= 3);
			assert.deepEqual(gatewayRequests.map((request) => request.authorization), gatewayRequests.map(() => "Bearer title-token"));

			prefs.set(`providerKey.gateway.${enterprise.id}`, "!exit 1");
			const beforeFailure = service.getRequests().length;
			await assert.rejects(generateSessionTitle([{ role: "user", content: "No unauthenticated retry." }], options), GatewayCredentialResolutionError);
			await assert.rejects(generateGoalSummaryTitle("No unauthenticated retry", options), GatewayCredentialResolutionError);
			assert.equal(service.getRequests().length, beforeFailure, "credential resolution failures must make zero gateway fetch calls");
		} finally {
			await service.close();
		}
	});

	it("redacts implicit gateway title and summary failure bodies and caught request errors", async () => {
		const sentinel = `gateway-secret-${"x".repeat(48)}`;
		const authorization = `Bearer ${sentinel}`;
		const captured = captureConsoleErrors();
		try {
			for (const status of [401, 500]) {
				const service = await startTitleGateway(sentinel, { status, body: `provider body ${authorization} ${sentinel}` });
				try {
					const enterprise = gateway("aigw", service.url, "aigw");
					const prefs = new PreferencesStore(path.join(agentDir, `implicit-failure-${status}`));
					prefs.set(`providerKey.gateway.${enterprise.id}`, sentinel);
					const options = { gateways: [enterprise], aigwGateway: enterprise, preferencesStore: prefs };
					assert.equal(await generateSessionTitle([{ role: "user", content: "Secure failure title" }], options), null);
					assert.equal(await generateGoalSummaryTitle("Secure failure summary", options), null);
					const completionRequests = service.getRequests().filter((request) => request.path === "/v1/chat/completions");
					assert.deepEqual(completionRequests.map((request) => request.authorization), [authorization, authorization]);
				} finally {
					await service.close();
				}
			}

			const service = await startTitleGateway(sentinel);
			try {
				const enterprise = gateway("aigw", service.url, "aigw");
				const prefs = new PreferencesStore(path.join(agentDir, "implicit-thrown-failure"));
				prefs.set(`providerKey.gateway.${enterprise.id}`, sentinel);
				const requests: RequestInit[] = [];
				const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
					if (String(input).endsWith("/models")) {
						return new Response(JSON.stringify({ data: [{ id: "claude-haiku-local" }] }), { status: 200 });
					}
					requests.push(init ?? {});
					throw new Error(`gateway transport rejected Authorization: ${authorization}`);
				}) as typeof fetch;
				const options = { gateways: [enterprise], aigwGateway: enterprise, preferencesStore: prefs, fetchImpl };
				assert.equal(await generateSessionTitle([{ role: "user", content: "Thrown failure title" }], options), null);
				assert.equal(await generateGoalSummaryTitle("Thrown failure summary", options), null);
				assert.deepEqual(requests.map((request) => (request.headers as Record<string, string>).Authorization), [authorization, authorization]);
			} finally {
				await service.close();
			}

			const output = captured.lines.join("\n");
			assert.equal(output.includes(sentinel), false, "gateway credentials must never reach title logs");
			assert.equal(output.includes("provider body"), false, "provider response bodies must never reach title logs");
			assert.equal(output.includes("Authorization: Bearer"), false, "caught authorization context must be sanitized");
			assert.match(output, /authentication failed/);
			assert.match(output, /request failed \(HTTP 500\)/);
			assert.match(output, /<redacted-token>/);
		} finally {
			captured.restore();
		}
	});

	it("routes explicit title tuples through their named gateway model and reserves implicit Claude fallback for AIGW", async () => {
		const local = gateway("local-a", "http://127.0.0.1:1234");
		const model: ApiModel = {
			id: "claude-local", name: "Claude local", provider: local.name, api: "openai-completions", baseUrl: `${local.url}/v1`,
			contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: COST, authenticated: true,
		};
		const calls: ApiModel[] = [];
		const title = await generateSessionTitle([{ role: "user", content: "Use the local gateway." }], {
			namingModel: "local-a/claude-local",
			gateways: [local],
			availableModels: [model],
			directModelCompleter: async (selected) => {
				calls.push(selected);
				return "<title>Local Gateway</title>";
			},
		});
		assert.equal(title, "Local Gateway");
		assert.deepEqual(calls.map(({ provider, id }) => ({ provider, id })), [{ provider: "local-a", id: "claude-local" }]);

		const prefs = new PreferencesStore(path.join(agentDir, "title-state"));
		prefs.set("modelGateways", [local]);
		const manager: any = new SessionManager({ preferencesStore: prefs, stateDir: path.join(agentDir, "title-session-state") });
		const localOptions = manager.getTitleGenOptions();
		assert.deepEqual(localOptions.gateways.map((row: ModelGateway) => row.name), ["local-a"]);
		assert.equal(localOptions.aigwUrl, undefined, "OpenAI-compatible Claude ids cannot enable implicit AIGW fallback");
		const enterprise = gateway("aigw", "http://127.0.0.1:7777", "aigw");
		prefs.set("modelGateways", [local, enterprise]);
		const enterpriseOptions = manager.getTitleGenOptions();
		assert.deepEqual(enterpriseOptions.gateways.map((row: ModelGateway) => row.name), ["local-a", "aigw"]);
		assert.equal(enterpriseOptions.aigwUrl, enterprise.url);
	});
});

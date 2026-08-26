// Reproducer: a pre-v0.17.0 (unmarked) Bobbit `providers.aigw` publication must be
// adopted on the ordinary model-registry read path, so live gateway discovery resumes
// and upstream-provider provenance is restored without any separate refresh call.

import { guardProcessEnv } from "./_helpers/env-guard.js";
guardProcessEnv();

import { afterEach, beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { findNodeAtLocation, parseTree } from "jsonc-parser";
import { resetAgentDirStateForTests } from "../../../src/server/bobbit-dir.js";
import { PreferencesStore } from "../../../src/server/agent/preferences-store.js";
import {
	findSessionSelectableModel,
	getAvailableModels,
	invalidateModelCache,
} from "../../../src/server/agent/model-registry.js";
import {
	AigwModelsJsonOwnershipError,
	adoptLegacyAigwProvider,
	inspectAigwTargetRealm,
} from "../../../src/server/agent/aigw-models-json.js";
import {
	writeAigwModelsJson,
	writeModelsJsonText,
	type AigwModel,
} from "../../../src/server/agent/aigw-manager.js";
import { BOBBIT_AIGW_USER_AGENT } from "../../../src/server/agent/aigw-user-agent.js";

/** Every assertion in this file carries this token so the gate can match the failure. */
const NOT_ADOPTED = "legacy AIGW publication was not adopted";

/** Only present in the live gateway catalogue — never in the on-disk legacy block. */
const LIVE_ONLY_ID = "openai/live-only-model";
/** Only present in the on-disk legacy block — never advertised by the gateway. */
const LEGACY_ONLY_ID = "gpt-5.6-sol";
/** The exact session-header command every Bobbit publication generates. */
const SESSION_HEADER = `!node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`;

/**
 * Reachable stub gateway. `/.well-known/opencode` is absent (404) so discovery
 * takes the documented `/v1/models` fallback, whose slash-prefixed ids carry
 * upstream-provider provenance.
 */
function startGateway(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
	const requests: string[] = [];
	const server = http.createServer((req, res) => {
		requests.push(req.url ?? "");
		if (req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				data: [{ id: LIVE_ONLY_ID, object: "model", context_length: 200_000, max_tokens: 32_000 }],
			}));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				requests,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

/**
 * Byte-exact shape of a `providers.aigw` block written by Bobbit v0.16.3: the
 * deterministic generated key set and headers, model rows carrying
 * `upstreamProvider`, and NO `x-bobbit-managed` marker.
 */
function legacyPublication(gatewayUrl: string, userAgent = "Bobbit/0.16.3"): string {
	return `${JSON.stringify({
		providers: {
			aigw: {
				baseUrl: gatewayUrl,
				apiKey: "none",
				api: "openai-completions",
				headers: {
					"User-Agent": userAgent,
					"x-opencode-session": SESSION_HEADER,
				},
				models: [{
					id: LEGACY_ONLY_ID,
					upstreamProvider: "openai",
					name: "GPT 5.6 Sol",
					contextWindow: 400_000,
					maxTokens: 128_000,
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
					api: "openai-completions",
					baseUrl: `${gatewayUrl}/openai/v1`,
				}],
			},
		},
	}, null, 2)}\n`;
}

describe("AIGW legacy block adoption", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-legacy-adoption-"));
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

	it("adopts an unmarked pre-0.17.0 Bobbit publication on the first model read", async () => {
		const gateway = await startGateway();
		try {
			const modelsPath = path.join(agentDir, "models.json");
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("aigw.url", gateway.url);
			fs.writeFileSync(modelsPath, legacyPublication(gateway.url));

			const models = await getAvailableModels(prefs);

			// 1. Live gateway discovery must run again, so the gateway-only id is selectable.
			assert.ok(
				findSessionSelectableModel(models, "aigw", LIVE_ONLY_ID),
				`${NOT_ADOPTED}: live gateway discovery was skipped, so ${LIVE_ONLY_ID} never became selectable`,
			);
			assert.ok(
				gateway.requests.includes("/v1/models"),
				`${NOT_ADOPTED}: no discovery request reached the reachable gateway`,
			);

			// 2. Every aigw row must keep its upstream-provider provenance.
			const aigwRows = models.filter((model) => model.provider === "aigw");
			assert.ok(aigwRows.length > 0, `${NOT_ADOPTED}: no aigw rows were returned at all`);
			assert.deepEqual(
				aigwRows.filter((row) => !row.upstreamProvider).map((row) => row.id),
				[],
				`${NOT_ADOPTED}: aigw rows lost their upstreamProvider provenance, so Default Models render bare ids`,
			);

			// 3. The marker must be persisted by that same read — no refresh, no publication call.
			const adopted = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as {
				providers?: { aigw?: Record<string, unknown> };
			};
			assert.deepEqual(
				adopted.providers?.aigw?.["x-bobbit-managed"],
				{ kind: "aigw-publication", version: 1 },
				`${NOT_ADOPTED}: x-bobbit-managed is still missing from models.json, so the install can never self-heal`,
			);
		} finally {
			await gateway.close();
		}
	});

	it("serves the adopted catalogue with provenance from the persisted marker on a later read", async () => {
		const gateway = await startGateway();
		const modelsPath = path.join(agentDir, "models.json");
		const prefs = new PreferencesStore(path.join(agentDir, "state"));
		prefs.set("aigw.url", gateway.url);
		fs.writeFileSync(modelsPath, legacyPublication(gateway.url));

		await getAvailableModels(prefs);
		await gateway.close();
		invalidateModelCache();

		// Fresh registry state, unreachable gateway: only the marker persisted by the
		// first read can keep the retained catalogue (and its provenance) usable.
		const retained = await getAvailableModels(prefs);
		const legacyRow = findSessionSelectableModel(retained, "aigw", LEGACY_ONLY_ID);
		assert.ok(legacyRow, "the adopted block must back discovery failure as a managed retained catalogue");
		assert.equal(legacyRow.upstreamProvider, "openai");
		assert.equal(inspectAigwTargetRealm(fs.readFileSync(modelsPath, "utf-8")).kind, "managed");
	});

	it("logs exactly one sanitized notice for a user-owned block and none for an adopted one", async () => {
		const gateway = await startGateway();
		try {
			const modelsPath = path.join(agentDir, "models.json");
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("aigw.url", gateway.url);
			// Valid, loadable, but not recognisably Bobbit's own output: an extra field.
			const userOwned = legacyPublication(gateway.url)
				.replace('"apiKey": "none"', '"handAuthored": true,\n        "apiKey": "none"');
			fs.writeFileSync(modelsPath, userOwned);

			const warnings: string[] = [];
			const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
				warnings.push(args.map((arg) => String(arg)).join(" "));
			});
			let now = Date.now();
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			try {
				const first = await getAvailableModels(prefs);
				now += 5_001;
				await getAvailableModels(prefs);

				// Established user-owned behaviour is unchanged: the block's own rows are
				// served, without provenance, and its bytes are untouched.
				const userRow = findSessionSelectableModel(first, "aigw", LEGACY_ONLY_ID);
				assert.ok(userRow, "a user-owned block must still compose its own rows");
				assert.equal(userRow.upstreamProvider, undefined);
				assert.equal(fs.readFileSync(modelsPath, "utf-8"), userOwned);

				const notices = warnings.filter((line) => line.includes("providers.aigw") && line.includes("user-owned"));
				assert.equal(notices.length, 1, `expected exactly one user-owned notice, got ${notices.length}`);
				assert.match(notices[0], /live AI Gateway discovery is skipped/);
				assert.match(notices[0], /upstream-provider tags are unavailable/);
				for (const secret of ["Bobbit/0.16.3", SESSION_HEADER, LEGACY_ONLY_ID, '"apiKey"', "handAuthored"]) {
					assert.ok(!notices[0].includes(secret), `the notice must not echo file contents: ${secret}`);
				}

				// An adopted block is managed, so it must never produce the notice.
				warnings.length = 0;
				fs.writeFileSync(modelsPath, legacyPublication(gateway.url));
				invalidateModelCache();
				await getAvailableModels(prefs);
				assert.deepEqual(warnings.filter((line) => line.includes("user-owned")), []);
			} finally {
				clock.mockRestore();
				warn.mockRestore();
			}
		} finally {
			await gateway.close();
		}
	});

	it("repairs a legacy block on the publication path and still refuses a hand-authored one", () => {
		const modelsPath = path.join(agentDir, "models.json");
		const gatewayUrl = "http://aigw.example.test/v1";
		const published: AigwModel[] = [{
			id: "published-model",
			name: "Published Model",
			api: "openai-completions",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_000,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			baseUrl: `${gatewayUrl}/openai/v1`,
			upstreamProvider: "openai",
		}];

		fs.writeFileSync(modelsPath, legacyPublication(gatewayUrl));
		writeAigwModelsJson(gatewayUrl, published);
		const refreshed = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
		assert.deepEqual(refreshed.providers.aigw["x-bobbit-managed"], { kind: "aigw-publication", version: 1 });
		assert.deepEqual(refreshed.providers.aigw.models.map((model: { id: string }) => model.id), ["published-model"]);

		const handAuthored = legacyPublication(gatewayUrl).replace('"apiKey": "none"', '"apiKey": "user-secret"');
		fs.writeFileSync(modelsPath, handAuthored);
		assert.throws(() => writeAigwModelsJson(gatewayUrl, published), /refusing|user-owned/);
		assert.equal(fs.readFileSync(modelsPath, "utf-8"), handAuthored);

		const unsupportedRelease = legacyPublication(gatewayUrl, "Bobbit/0.17.0");
		fs.writeFileSync(modelsPath, unsupportedRelease);
		assert.throws(() => writeAigwModelsJson(gatewayUrl, published), /refusing|user-owned/);
		assert.equal(
			fs.readFileSync(modelsPath, "utf-8"),
			unsupportedRelease,
			"publication must refuse and preserve an unsupported User-Agent byte-for-byte",
		);
	});
});

// ── permission preservation on the single models.json writer ────────

/** POSIX modes are not meaningful on Windows; the functional assertions still run there. */
const POSIX_MODES = process.platform !== "win32";

function modeOf(target: string): number {
	return fs.statSync(target).mode & 0o777;
}

/** A legacy publication that also carries a hand-authored sibling provider with a real key. */
function legacyWithSecretSibling(gatewayUrl: string): string {
	const document = JSON.parse(legacyPublication(gatewayUrl)) as {
		providers: Record<string, unknown>;
	};
	document.providers = {
		anthropic: { apiKey: "user-secret-key", api: "anthropic" },
		...document.providers,
	};
	return `${JSON.stringify(document, null, 2)}\n`;
}

describe("models.json permission preservation", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.BOBBIT_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-aigw-legacy-mode-"));
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

	it.skipIf(!POSIX_MODES)("preserves an existing 0o000 models.json across direct atomic replacement", () => {
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(modelsPath, "original\n", { mode: 0o600 });
		fs.chmodSync(modelsPath, 0o000);

		writeModelsJsonText("replacement\n");
		const replacementMode = modeOf(modelsPath);
		// Restore owner access only after observing the replacement's mode so the
		// content assertion can verify the write completed through the open fd.
		fs.chmodSync(modelsPath, 0o600);

		assert.equal(fs.readFileSync(modelsPath, "utf-8"), "replacement\n");
		assert.equal(replacementMode, 0o000, "atomic replacement must preserve a valid zero mode");
	});

	it("keeps a 0o600 models.json owner-only when the read path adopts a legacy block", async () => {
		const gateway = await startGateway();
		try {
			const modelsPath = path.join(agentDir, "models.json");
			const prefs = new PreferencesStore(path.join(agentDir, "state"));
			prefs.set("aigw.url", gateway.url);
			fs.writeFileSync(modelsPath, legacyWithSecretSibling(gateway.url), { mode: 0o600 });
			fs.chmodSync(modelsPath, 0o600);

			const models = await getAvailableModels(prefs);

			// Adoption and live discovery are unaffected by the tightened mode.
			assert.ok(
				findSessionSelectableModel(models, "aigw", LIVE_ONLY_ID),
				`${NOT_ADOPTED}: live gateway discovery was skipped for a 0o600 models.json`,
			);
			const adopted = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as {
				providers?: Record<string, Record<string, unknown>>;
			};
			assert.deepEqual(
				adopted.providers?.aigw?.["x-bobbit-managed"],
				{ kind: "aigw-publication", version: 1 },
				`${NOT_ADOPTED}: the marker was not persisted for a 0o600 models.json`,
			);

			// The hand-authored sibling's secret must survive the rewrite verbatim.
			assert.deepEqual(adopted.providers?.anthropic, { apiKey: "user-secret-key", api: "anthropic" });
			assert.ok(fs.readFileSync(modelsPath, "utf-8").includes("user-secret-key"));

			if (POSIX_MODES) {
				assert.equal(
					modeOf(modelsPath).toString(8),
					(0o600).toString(8),
					"adoption on the read path must not widen models.json beyond the owner",
				);
			}
		} finally {
			await gateway.close();
		}
	});

	it("keeps a 0o600 models.json owner-only when the publication path adopts a legacy block", () => {
		const modelsPath = path.join(agentDir, "models.json");
		const gatewayUrl = "http://aigw.example.test/v1";
		fs.writeFileSync(modelsPath, legacyWithSecretSibling(gatewayUrl), { mode: 0o600 });
		fs.chmodSync(modelsPath, 0o600);

		writeAigwModelsJson(gatewayUrl, [{
			id: "published-model",
			name: "Published Model",
			api: "openai-completions",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_000,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			baseUrl: `${gatewayUrl}/openai/v1`,
			upstreamProvider: "openai",
		}]);

		const refreshed = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
		assert.deepEqual(refreshed.providers.aigw["x-bobbit-managed"], { kind: "aigw-publication", version: 1 });
		assert.deepEqual(refreshed.providers.anthropic, { apiKey: "user-secret-key", api: "anthropic" });
		if (POSIX_MODES) {
			assert.equal(
				modeOf(modelsPath).toString(8),
				(0o600).toString(8),
				"publication must not widen an owner-only models.json",
			);
		}
	});

	it("creates a brand new models.json owner-only", () => {
		const modelsPath = path.join(agentDir, "models.json");
		const gatewayUrl = "http://aigw.example.test/v1";
		assert.equal(fs.existsSync(modelsPath), false);

		writeAigwModelsJson(gatewayUrl, [{
			id: "published-model",
			name: "Published Model",
			api: "openai-completions",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_000,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			baseUrl: `${gatewayUrl}/openai/v1`,
		}]);

		assert.ok(fs.existsSync(modelsPath), "publication must create models.json when it is absent");
		if (POSIX_MODES) {
			assert.equal(
				modeOf(modelsPath).toString(8),
				(0o600).toString(8),
				"a freshly created models.json must default to owner-only",
			);
		}
	});
});

// ── adoptLegacyAigwProvider — recognition and byte preservation ─────

const CONFIGURED = "http://aigw.example.test/v1";

/**
 * A legacy publication wrapped in a document that also carries a root comment,
 * an unknown root field, a commented sibling provider, and trailing commas
 * *outside* the `providers.aigw` object. None of that may affect adoption, and
 * every byte of it must survive untouched.
 */
function legacyJsoncDocument(baseUrl = CONFIGURED, userAgent = "Bobbit/0.16.3"): string {
	return `{
  // retained root comment
  "unknownRoot": { "keep": true },
  "providers": {
    // sibling provider comment
    "anthropic": { "apiKey": "user-secret" },
    "aigw": {
      "baseUrl": ${JSON.stringify(baseUrl)},
      "apiKey": "none",
      "api": "openai-completions",
      "headers": {
        "User-Agent": ${JSON.stringify(userAgent)},
        "x-opencode-session": ${JSON.stringify(SESSION_HEADER)}
      },
      "models": [
        { "id": "gpt-5.6-sol", "upstreamProvider": "openai", "name": "GPT 5.6 Sol" }
      ]
    },
  },
  "modelOverrides": { "user": true },
}
`;
}

/** Replace the `providers.aigw` value with a placeholder to compare the rest byte-for-byte. */
function outsideAigwBlock(text: string): string {
	const root = parseTree(text, [], { allowTrailingComma: true });
	const node = root ? findNodeAtLocation(root, ["providers", "aigw"]) : undefined;
	assert.ok(node, "fixture must contain a providers.aigw block");
	return `${text.slice(0, node.offset)}<<aigw>>${text.slice(node.offset + node.length)}`;
}

describe("adoptLegacyAigwProvider", () => {
	it("adopts a legacy publication and preserves every byte outside the block", () => {
		const source = legacyJsoncDocument();
		const result = adoptLegacyAigwProvider(source, CONFIGURED);

		assert.equal(result.adopted, true, `${NOT_ADOPTED}: a byte-exact v0.16.3 publication was left user-owned`);
		assert.ok(result.text);
		assert.equal(result.realm.kind, "managed");
		assert.equal(inspectAigwTargetRealm(result.text).kind, "managed");
		assert.equal(
			outsideAigwBlock(result.text),
			outsideAigwBlock(source),
			"adoption must not touch any byte outside the providers.aigw object",
		);

		// Inside the block, the marker is the only addition.
		const before = JSON.parse(JSON.stringify(inspectAigwTargetRealm(source)));
		const after = JSON.parse(JSON.stringify(inspectAigwTargetRealm(result.text)));
		assert.deepEqual(after.provider["x-bobbit-managed"], { kind: "aigw-publication", version: 1 });
		delete after.provider["x-bobbit-managed"];
		assert.deepEqual(after.provider, before.provider);
	});

	it("adopts when the configured URL differs only by trailing slash or host case", () => {
		for (const configured of [`${CONFIGURED}/`, "http://AIGW.example.test/v1", `${CONFIGURED}//`]) {
			const source = legacyJsoncDocument();
			const result = adoptLegacyAigwProvider(source, configured);
			assert.equal(result.adopted, true, `${NOT_ADOPTED}: equivalent gateway URL ${configured} was rejected`);
		}
	});

	it("adopts every published pre-marker User-Agent and no other release boundary", () => {
		const publishedLegacyUserAgents = [
			"Bobbit/0.12.0",
			"Bobbit/0.13.0",
			"Bobbit/0.13.1",
			"Bobbit/0.14.0",
			"Bobbit/0.14.1",
			"Bobbit/0.14.2",
			"Bobbit/0.15.0",
			"Bobbit/0.15.1",
			"Bobbit/0.16.1",
			"Bobbit/0.16.2",
			"Bobbit/0.16.3",
		];
		for (const userAgent of publishedLegacyUserAgents) {
			const result = adoptLegacyAigwProvider(legacyJsoncDocument(CONFIGURED, userAgent), CONFIGURED);
			assert.equal(result.adopted, true, `${NOT_ADOPTED}: published legacy ${userAgent} was rejected`);
			assert.equal(result.realm.kind, "managed");
		}
	});

	it("keeps arbitrary, marker-era, and current Bobbit User-Agents user-owned and byte-identical", () => {
		for (const userAgent of ["Bobbit/not-a-release", "Bobbit/0.17.0", BOBBIT_AIGW_USER_AGENT]) {
			const source = legacyJsoncDocument(CONFIGURED, userAgent);
			const result = adoptLegacyAigwProvider(source, CONFIGURED);
			assert.equal(result.adopted, false, `${userAgent} must not be adopted`);
			assert.equal(result.realm.kind, "unmarked-user", `${userAgent} must remain user-owned`);
			assert.equal(result.text, source, `${userAgent} must remain byte-identical`);
		}
	});

	it("leaves every block that is not recognisably Bobbit's own output byte-identical", () => {
		const base = legacyJsoncDocument();
		const variants: Array<[string, string]> = [
			["comment inside the block", base.replace('"aigw": {', '"aigw": {\n      // hand-edited by the user')],
			["trailing comma inside the block", base.replace("      ]\n    },", "      ],\n    },")],
			["extra provider field", base.replace('"apiKey": "none"', '"handAuthored": true,\n      "apiKey": "none"')],
			["missing headers", base.replace(/\s+"headers": \{[\s\S]*?\n      \},/, "")],
			["third header", base.replace('"User-Agent": "Bobbit/0.16.3",', '"X-Extra": "1",\n        "User-Agent": "Bobbit/0.16.3",')],
			["non-Bobbit User-Agent", base.replace("Bobbit/0.16.3", "CustomClient/1.0")],
			["altered x-opencode-session", base.replace("BOBBIT_SESSION_ID", "OTHER_SESSION_ID")],
			["apiKey other than none", base.replace('"apiKey": "none"', '"apiKey": "user-secret"')],
			["different-origin baseUrl", legacyJsoncDocument("http://other.example.test/v1")],
			["models is not an array", base.replace(/"models": \[[\s\S]*?\n      \]/, '"models": {}')],
		];
		for (const [label, source] of variants) {
			assert.notEqual(source, base, `variant fixture "${label}" did not change the document`);
			const result = adoptLegacyAigwProvider(source, CONFIGURED);
			assert.equal(result.adopted, false, `"${label}" must stay user-owned`);
			assert.equal(result.realm.kind, "unmarked-user", `"${label}" must classify as unmarked-user`);
			assert.equal(result.text, source, `"${label}" must be returned byte-identical`);
		}
	});

	it("never adopts absent, already-managed, or non-object providers.aigw", () => {
		const absent = adoptLegacyAigwProvider(undefined, CONFIGURED);
		assert.deepEqual({ adopted: absent.adopted, kind: absent.realm.kind }, { adopted: false, kind: "absent" });

		const noProvider = adoptLegacyAigwProvider('{"providers":{}}', CONFIGURED);
		assert.deepEqual({ adopted: noProvider.adopted, kind: noProvider.realm.kind }, { adopted: false, kind: "absent" });

		const marked = legacyJsoncDocument().replace('"aigw": {', '"aigw": {\n      "x-bobbit-managed": { "kind": "aigw-publication", "version": 1 },');
		const managed = adoptLegacyAigwProvider(marked, CONFIGURED);
		assert.equal(managed.adopted, false);
		assert.equal(managed.realm.kind, "managed");
		assert.equal(managed.text, marked);

		const notObject = adoptLegacyAigwProvider('{"providers":{"aigw":42}}', CONFIGURED);
		assert.equal(notObject.adopted, false);
		assert.equal(notObject.realm.kind, "invalid");
		assert.equal(notObject.text, '{"providers":{"aigw":42}}');
	});

	it("fails closed on ambiguous or malformed documents before considering any mutation", () => {
		const fixtures = [
			'{"providers":{},"providers":{"other":{}}}',
			'{"providers":{"aigw":{},"aigw":{"models":[]}}}',
			'{"providers":{"aigw":{"baseUrl":"one","baseUrl":"two"}}}',
			'{ "providers": { /* malformed */ ',
			'{"providers":[]}',
		];
		for (const fixture of fixtures) {
			assert.throws(
				() => adoptLegacyAigwProvider(fixture, CONFIGURED),
				(error: unknown) => error instanceof AigwModelsJsonOwnershipError
					&& /duplicate|malformed|not an object/.test((error as Error).message),
				`expected a fail-closed ownership error for: ${fixture}`,
			);
		}
	});
});

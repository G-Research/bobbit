/**
 * Unit tests for the OAuth callbacks added to satisfy
 * `@earendil-works/pi-ai@0.75.x`'s expanded `OAuthLoginCallbacks` contract.
 *
 * Contract under test (see `src/server/auth/oauth.ts::oauthStartExternal`):
 *   - `onDeviceCode` must surface the user-code + verification URI through
 *     the `started` promise so the UI dialog can display them.
 *   - `onSelect` with a single option must auto-pick that option's id
 *     (deterministic, no UI required).
 *   - `onSelect` presented with the real Codex login-method options
 *     (browser + device_code) must return the browser-login option id
 *     (`"browser"` / `OPENAI_CODEX_BROWSER_LOGIN_METHOD`) so the flow uses
 *     Bobbit's existing callback-server / paste-code UX.
 *   - `onSelect` with multiple *unrecognised* options must reject with a clear
 *     "Bobbit does not support" error so the flow fails loudly rather than
 *     hanging.
 *
 * Strategy: register a fake `OAuthProviderInterface` with id `openai-codex`
 * via `pi-ai/oauth::registerOAuthProvider`; that override is honoured by
 * `getOAuthProvider("openai-codex")`. The fake provider's `login()` captures
 * the supplied callbacks so we can drive them directly from the test.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "bobbit-oauth-cb-"));
mkdirSync(path.join(tmp, "agent"), { recursive: true });
process.env.BOBBIT_AGENT_DIR = path.join(tmp, "agent");

const piOAuth = await import("@earendil-works/pi-ai/oauth");
const { oauthStart, oauthFlowStatus, stopFlowCleanup } = await import("../src/server/auth/oauth.js");

type Callbacks = Parameters<NonNullable<ReturnType<typeof piOAuth.getOAuthProvider>>["login"]>[0];

interface Capture {
	callbacks?: Callbacks;
	loginResolve?: (creds: any) => void;
	loginReject?: (err: Error) => void;
}

function installFakeProvider(capture: Capture): void {
	piOAuth.registerOAuthProvider({
		id: "openai-codex",
		name: "OpenAI (Fake)",
		usesCallbackServer: true,
		async refreshToken(creds: any) { return creds; },
		getApiKey() { return "fake-api-key"; },
		login(callbacks: Callbacks) {
			capture.callbacks = callbacks;
			return new Promise((resolve, reject) => {
				capture.loginResolve = resolve;
				capture.loginReject = reject;
			});
		},
	} as any);
}

describe("oauthStartExternal — pi-ai 0.75 OAuthLoginCallbacks contract", () => {
	before(() => {
		// Silence the [oauth] info-level logs the device-code branch emits.
	});

	after(() => {
		piOAuth.resetOAuthProviders();
		stopFlowCleanup();
	});

	it("onDeviceCode surfaces userCode + verificationUri via the started promise", async () => {
		const capture: Capture = {};
		installFakeProvider(capture);

		// `oauthStart("openai-codex")` awaits the `started` promise inside
		// `oauthStartExternal`. Drive `onDeviceCode` asynchronously so the
		// start call sees it resolve.
		const startPromise = oauthStart("openai-codex");

		// Spin until the fake `login()` has been invoked and captured callbacks.
		for (let i = 0; i < 100 && !capture.callbacks; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(capture.callbacks, "fake provider login() should have been called");

		capture.callbacks!.onDeviceCode({
			userCode: "ABCD-1234",
			verificationUri: "https://example.test/device",
			intervalSeconds: 5,
			expiresInSeconds: 600,
		});

		const started = await startPromise;
		assert.equal(started.url, "https://example.test/device");
		assert.ok(
			started.instructions && started.instructions.includes("ABCD-1234"),
			`instructions should include the user code; got: ${started.instructions}`,
		);
		assert.ok(
			started.instructions!.includes("https://example.test/device"),
			"instructions should include the verification URI",
		);

		// Tidy: reject the still-pending login() so the flow's loginPromise
		// settles and we don't leak an unhandled rejection across tests.
		capture.loginReject!(new Error("test teardown"));
		// Drain any pending microtask rejection from the wrapped login promise.
		await new Promise((r) => setTimeout(r, 10));
	});

	it("onSelect with a single option auto-picks that option's id", async () => {
		const capture: Capture = {};
		installFakeProvider(capture);

		const startPromise = oauthStart("openai-codex");

		for (let i = 0; i < 100 && !capture.callbacks; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(capture.callbacks);

		// Resolve `started` first so the start promise unblocks — onAuth path.
		capture.callbacks!.onAuth({ url: "https://example.test/auth" });
		await startPromise;

		const selected = await capture.callbacks!.onSelect({
			message: "Pick an org",
			options: [{ id: "org-1", label: "Only Org" }],
		});
		assert.equal(selected, "org-1");

		capture.loginReject!(new Error("test teardown"));
		await new Promise((r) => setTimeout(r, 10));
	});

	it("onSelect with the real Codex options returns the browser-login method id", async () => {
		const capture: Capture = {};
		installFakeProvider(capture);

		const startPromise = oauthStart("openai-codex");

		for (let i = 0; i < 100 && !capture.callbacks; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(capture.callbacks);

		capture.callbacks!.onAuth({ url: "https://example.test/auth" });
		await startPromise;

		const selected = await capture.callbacks!.onSelect({
			message: "Select OpenAI Codex login method:",
			options: [
				{ id: "browser", label: "Browser login (default)" },
				{ id: "device_code", label: "Device code login (headless)" },
			],
		});
		assert.equal(
			selected,
			"browser",
			"onSelect must deterministically pick the browser-login method",
		);

		capture.loginReject!(new Error("test teardown"));
		await new Promise((r) => setTimeout(r, 10));
	});

	it("onSelect with multiple unrecognised options rejects with a clear unsupported-flow error", async () => {
		const capture: Capture = {};
		installFakeProvider(capture);

		const startPromise = oauthStart("openai-codex");

		for (let i = 0; i < 100 && !capture.callbacks; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(capture.callbacks);

		capture.callbacks!.onAuth({ url: "https://example.test/auth" });
		const started = await startPromise;
		const flowId = (started as any).flowId ?? null;
		void flowId; // unused — we drive the callback directly

		await assert.rejects(
			capture.callbacks!.onSelect({
				message: "Pick one",
				options: [
					{ id: "a", label: "Option A" },
					{ id: "b", label: "Option B" },
				],
			}),
			/does not support/i,
			"multi-option unrecognised onSelect must reject with a Bobbit-specific unsupported-flow error",
		);

		capture.loginReject!(new Error("test teardown"));
		await new Promise((r) => setTimeout(r, 10));
	});

	it("onDeviceCode after onAuth does not overwrite the started value", async () => {
		const capture: Capture = {};
		installFakeProvider(capture);

		const startPromise = oauthStart("openai-codex");
		for (let i = 0; i < 100 && !capture.callbacks; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.ok(capture.callbacks);

		capture.callbacks!.onAuth({ url: "https://example.test/auth", instructions: "go here" });
		const started = await startPromise;
		assert.equal(started.url, "https://example.test/auth");

		// Firing onDeviceCode after `started` is already resolved must be safe
		// (it should log only). We assert no throw and started shape unchanged.
		assert.doesNotThrow(() => {
			capture.callbacks!.onDeviceCode({ userCode: "X", verificationUri: "https://later" });
		});

		capture.loginReject!(new Error("test teardown"));
		await new Promise((r) => setTimeout(r, 10));
	});
});

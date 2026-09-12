import { guardProcessEnv } from "../../../tests/support/helpers/unit/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import {
	MCP_OPERATOR_AUTHORIZATION_FILE,
	MCP_OPERATOR_PAIRING_MAX_FAILURES,
	MCP_OPERATOR_PAIRING_TTL_MS,
	McpOperatorAuthorizationError,
	McpOperatorAuthorizer,
	type McpOperatorAuthorizerOptions,
} from "../../../src/server/auth/mcp-operator-authorizer.ts";

const temporaryRoots: string[] = [];

function temporarySecretsDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-operator-authorizer-"));
	temporaryRoots.push(root);
	return path.join(root, "secrets");
}

function authorizer(options: McpOperatorAuthorizerOptions = {}): McpOperatorAuthorizer {
	return new McpOperatorAuthorizer({ secretsDir: temporarySecretsDir(), ...options });
}

function assertPairingError(code: string): (error: unknown) => boolean {
	return (error) => error instanceof McpOperatorAuthorizationError && error.code === code;
}

function incrementingRandom(): { randomBytes: (size: number) => Buffer; calls: number[] } {
	let next = 1;
	const calls: number[] = [];
	return {
		calls,
		randomBytes(size: number): Buffer {
			calls.push(size);
			return Buffer.alloc(size, next++);
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("McpOperatorAuthorizer pairing codes", () => {
	it("creates a 256-bit canonical base64url code with a ten-minute expiry and retains no raw code on disk", () => {
		const random = incrementingRandom();
		const secretsDir = temporarySecretsDir();
		const instance = new McpOperatorAuthorizer({ secretsDir, now: () => 1_700_000_000_000, randomBytes: random.randomBytes });
		const pairing = instance.createPairingCode();

		assert.match(pairing.code, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(Buffer.from(pairing.code, "base64url").length, 32);
		assert.equal(pairing.expiresAt, new Date(1_700_000_000_000 + MCP_OPERATOR_PAIRING_TTL_MS).toISOString());
		assert.deepEqual(random.calls, [32]);
		assert.equal(fs.existsSync(path.join(secretsDir, MCP_OPERATOR_AUTHORIZATION_FILE)), false);
	});

	it("replaces the previous live code and accepts only the newest definition", async () => {
		const instance = authorizer({ maxPairingFailures: 20 });
		const oldCode = instance.createPairingCode().code;
		const newCode = instance.createPairingCode().code;
		assert.notEqual(oldCode, newCode);

		await assert.rejects(instance.pair(oldCode, "one"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
		const { credential } = await instance.pair(newCode, "one");
		assert.ok(instance.verify(credential));
	});

	it("does not consume a valid code after malformed or incorrect attempts", async () => {
		const instance = authorizer({ maxPairingFailures: 20 });
		const code = instance.createPairingCode().code;
		const invalid = [
			"",
			` ${code}`,
			`${code} `,
			`${code}=`,
			code.slice(0, -1),
			Buffer.alloc(32, 91).toString("base64url"),
		];
		for (const candidate of invalid) {
			await assert.rejects(instance.pair(candidate, "client"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
		}
		const result = await instance.pair(code, "client");
		assert.ok(instance.verify(result.credential));
	});

	it("expires codes at the exact boundary and returns the same safe failure as replay", async () => {
		let now = 10_000;
		const instance = authorizer({ now: () => now, pairingTtlMs: 50, maxPairingFailures: 20 });
		const expired = instance.createPairingCode().code;
		now += 50;
		await assert.rejects(instance.pair(expired, "client"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));

		const current = instance.createPairingCode().code;
		const result = await instance.pair(current, "client");
		await assert.rejects(instance.pair(current, "client"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
		assert.ok(instance.verify(result.credential));
	});

	it("validates injected entropy and clock seams", () => {
		assert.throws(
			() => authorizer({ randomBytes: (size) => Buffer.alloc(size - 1) }).createPairingCode(),
			/exactly 32 bytes/,
		);
		assert.throws(() => authorizer({ now: () => Number.NaN }).createPairingCode(), /invalid timestamp/);
		assert.throws(() => authorizer({ pairingTtlMs: 0 }), /pairingTtlMs must be a positive integer/);
	});
});

describe("McpOperatorAuthorizer credentials", () => {
	it("returns the strict v1 128-bit-id and 256-bit-secret format with a purpose-bound claim", async () => {
		const random = incrementingRandom();
		const instance = authorizer({ randomBytes: random.randomBytes });
		const code = instance.createPairingCode().code;
		const { credential } = await instance.pair(code, "client");
		const [version, id, secret] = credential.split(".");

		assert.equal(version, "v1");
		assert.match(id!, /^[A-Za-z0-9_-]{22}$/);
		assert.match(secret!, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(Buffer.from(id!, "base64url").length, 16);
		assert.equal(Buffer.from(secret!, "base64url").length, 32);
		assert.deepEqual(instance.verify(credential), { purpose: "mcp-approval:v1", credentialId: id });
		assert.deepEqual(random.calls, [32, 16, 32, 8]);
	});

	it("strictly rejects missing, padded, whitespace-wrapped, wrong-version, wrong-length, and modified credentials", async () => {
		const instance = authorizer();
		const code = instance.createPairingCode().code;
		const { credential } = await instance.pair(code, "client");
		const [, id, secret] = credential.split(".");
		const modifiedSecret = Buffer.from(Buffer.from(secret!, "base64url").map((byte, index) => index === 0 ? byte ^ 1 : byte)).toString("base64url");
		const candidates = [
			undefined,
			"",
			credential + " ",
			" " + credential,
			credential + "=",
			`v2.${id}.${secret}`,
			`v1.${id}.${secret}.extra`,
			`v1.${id!.slice(1)}.${secret}`,
			`v1.${Buffer.alloc(16, 9).toString("base64url")}.${secret}`,
			`v1.${id}.${modifiedSecret}`,
		];
		for (const candidate of candidates) assert.equal(instance.verify(candidate), undefined);
		assert.ok(instance.verify(credential));
	});

	it("revokes the old browser credential only after successful re-pairing", async () => {
		const instance = authorizer();
		const first = await instance.pair(instance.createPairingCode().code, "client");
		assert.ok(instance.verify(first.credential));
		const secondCode = instance.createPairingCode().code;
		assert.ok(instance.verify(first.credential));
		const second = await instance.pair(secondCode, "client");

		assert.equal(instance.verify(first.credential), undefined);
		assert.ok(instance.verify(second.credential));
		assert.notEqual(first.credential, second.credential);
	});

	it("serializes exchanges so exactly one concurrent use of a code wins", async () => {
		const instance = authorizer({ maxPairingFailures: 20 });
		const code = instance.createPairingCode().code;
		const settled = await Promise.allSettled([
			instance.pair(code, "client-a"),
			instance.pair(code, "client-b"),
			instance.pair(code, "client-c"),
		]);
		const successes = settled.filter((result) => result.status === "fulfilled");
		const failures = settled.filter((result) => result.status === "rejected");

		assert.equal(successes.length, 1);
		assert.equal(failures.length, 2);
		for (const failure of failures) {
			assert.ok(failure.status === "rejected");
			assert.ok(assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED")(failure.reason));
		}
	});

	it("does not erase a newer code created while an accepted exchange is publishing", async () => {
		const instance = authorizer();
		const firstCode = instance.createPairingCode().code;
		const originalRename = fs.promises.rename;
		let publishStarted!: () => void;
		let resumePublish!: () => void;
		const started = new Promise<void>((resolve) => { publishStarted = resolve; });
		const paused = new Promise<void>((resolve) => { resumePublish = resolve; });
		vi.spyOn(fs.promises, "rename").mockImplementationOnce(async (source, destination) => {
			publishStarted();
			await paused;
			return originalRename(source, destination);
		});

		const firstPair = instance.pair(firstCode, "client");
		await started;
		const replacementCode = instance.createPairingCode().code;
		resumePublish();
		const first = await firstPair;
		const second = await instance.pair(replacementCode, "client");

		assert.equal(instance.verify(first.credential), undefined);
		assert.ok(instance.verify(second.credential));
	});
});

describe("McpOperatorAuthorizer persistence", () => {
	it("persists only a strict singleton verifier record with owner-only modes", async () => {
		const secretsDir = temporarySecretsDir();
		const instance = new McpOperatorAuthorizer({ secretsDir, now: () => 1_700_000_000_000 });
		const code = instance.createPairingCode().code;
		const { credential } = await instance.pair(code, "client");
		const [, id, secret] = credential.split(".");
		const authorizationPath = path.join(secretsDir, MCP_OPERATOR_AUTHORIZATION_FILE);
		const text = fs.readFileSync(authorizationPath, "utf8");
		const persisted = JSON.parse(text);

		assert.deepEqual(Object.keys(persisted).sort(), ["credential", "schema"]);
		assert.deepEqual(Object.keys(persisted.credential).sort(), ["createdAt", "id", "verifier"]);
		assert.equal(persisted.schema, 1);
		assert.equal(persisted.credential.id, id);
		assert.match(persisted.credential.verifier, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(persisted.credential.createdAt, new Date(1_700_000_000_000).toISOString());
		assert.doesNotMatch(text, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(text, new RegExp(secret!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(secretsDir).mode & 0o777, 0o700);
			assert.equal(fs.statSync(authorizationPath).mode & 0o777, 0o600);
		}
		assert.deepEqual(fs.readdirSync(secretsDir), [MCP_OPERATOR_AUTHORIZATION_FILE]);
	});

	it("reloads a durable verifier across restart without retaining a pairing code", async () => {
		const secretsDir = temporarySecretsDir();
		const first = new McpOperatorAuthorizer({ secretsDir });
		const code = first.createPairingCode().code;
		const { credential } = await first.pair(code, "client");
		const restarted = new McpOperatorAuthorizer({ secretsDir });

		assert.deepEqual(restarted.verify(credential), first.verify(credential));
		await assert.rejects(restarted.pair(code, "client"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
	});

	it("fails closed for every malformed persisted shape but permits explicit recovery with a fresh code", async () => {
		const variants: unknown[] = [
			{},
			{ schema: 2, credential: null },
			{ schema: 1, credential: null, extra: true },
			{ schema: 1, credential: {} },
			{ schema: 1, credential: { id: "bad", verifier: "bad", createdAt: "today" } },
			{ schema: 1, credential: { id: Buffer.alloc(16).toString("base64url"), verifier: Buffer.alloc(32).toString("base64url"), createdAt: new Date(0).toISOString(), extra: true } },
		];
		for (const malformed of variants) {
			const secretsDir = temporarySecretsDir();
			fs.mkdirSync(secretsDir, { recursive: true });
			fs.writeFileSync(path.join(secretsDir, MCP_OPERATOR_AUTHORIZATION_FILE), JSON.stringify(malformed));
			const instance = new McpOperatorAuthorizer({ secretsDir });
			assert.equal(instance.verify("v1.invalid.invalid"), undefined);
			const result = await instance.pair(instance.createPairingCode().code, "client");
			assert.ok(instance.verify(result.credential));
		}
	});

	it("fails closed on unreadable or non-regular state and does not expose raw filesystem errors", async () => {
		const secretsDir = temporarySecretsDir();
		fs.mkdirSync(secretsDir, { recursive: true });
		const statePath = path.join(secretsDir, MCP_OPERATOR_AUTHORIZATION_FILE);
		fs.mkdirSync(statePath);
		const instance = new McpOperatorAuthorizer({ secretsDir });
		assert.equal(instance.verify("v1.any.any"), undefined);
		const code = instance.createPairingCode().code;
		await assert.rejects(instance.pair(code, "client"), (error: unknown) => {
			assert.ok(error instanceof McpOperatorAuthorizationError);
			assert.equal(error.code, "MCP_OPERATOR_PERSIST_FAILED");
			assert.doesNotMatch(error.message, new RegExp(secretsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			return true;
		});
	});

	it("keeps the prior verifier and live code when atomic publication fails, then safely retries", async () => {
		const secretsDir = temporarySecretsDir();
		const instance = new McpOperatorAuthorizer({ secretsDir });
		const first = await instance.pair(instance.createPairingCode().code, "client");
		const rotationCode = instance.createPairingCode().code;
		vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("secret path leaked"), { code: "EACCES" }));

		await assert.rejects(instance.pair(rotationCode, "client"), assertPairingError("MCP_OPERATOR_PERSIST_FAILED"));
		assert.ok(instance.verify(first.credential));
		const retried = await instance.pair(rotationCode, "client");
		assert.equal(instance.verify(first.credential), undefined);
		assert.ok(instance.verify(retried.credential));
		assert.deepEqual(fs.readdirSync(secretsDir), [MCP_OPERATOR_AUTHORIZATION_FILE]);
	});
});

describe("McpOperatorAuthorizer rate limiting", () => {
	it("bounds failures per remote address without consuming the valid pairing code", async () => {
		const instance = authorizer({ maxPairingFailures: 2, pairingRateWindowMs: 100 });
		const code = instance.createPairingCode().code;
		for (let attempt = 0; attempt < 2; attempt++) {
			await assert.rejects(instance.pair("wrong", "attacker"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
		}
		await assert.rejects(instance.pair(code, "attacker"), assertPairingError("MCP_OPERATOR_PAIRING_RATE_LIMITED"));
		const result = await instance.pair(code, "human");
		assert.ok(instance.verify(result.credential));
	});

	it("resets a failure window after its bounded interval", async () => {
		let now = 100;
		const instance = authorizer({ now: () => now, maxPairingFailures: 1, pairingRateWindowMs: 10, pairingTtlMs: 1_000 });
		const code = instance.createPairingCode().code;
		await assert.rejects(instance.pair("wrong", "client"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
		await assert.rejects(instance.pair(code, "client"), assertPairingError("MCP_OPERATOR_PAIRING_RATE_LIMITED"));
		now += 10;
		const result = await instance.pair(code, "client");
		assert.ok(instance.verify(result.credential));
	});

	it("uses the documented default failed-attempt threshold", async () => {
		const instance = authorizer({ pairingRateWindowMs: 1_000, maxPairingFailures: MCP_OPERATOR_PAIRING_MAX_FAILURES });
		const code = instance.createPairingCode().code;
		for (let attempt = 0; attempt < MCP_OPERATOR_PAIRING_MAX_FAILURES; attempt++) {
			await assert.rejects(instance.pair("wrong", "client"), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
		}
		await assert.rejects(instance.pair(code, "client"), assertPairingError("MCP_OPERATOR_PAIRING_RATE_LIMITED"));
	});

	it("keeps the address table bounded while preserving authority in the pairing code", async () => {
		const instance = authorizer({ maxTrackedRemoteAddresses: 2, maxPairingFailures: 1, pairingRateWindowMs: 1_000 });
		const code = instance.createPairingCode().code;
		for (const address of ["one", "two", "three"]) {
			await assert.rejects(instance.pair("wrong", address), assertPairingError("MCP_OPERATOR_PAIRING_REQUIRED"));
		}
		const result = await instance.pair(code, "operator");
		assert.ok(instance.verify(result.credential));
	});
});

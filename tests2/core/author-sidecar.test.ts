import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	copyAuthorSidecar,
	createPromptAuthorStreamCorrelation,
	digestPromptModelText,
	extractPromptModelText,
	foldAuthorSidecarRecords,
	initAuthorSidecarDir,
	mergeAuthorSidecarIntoMessages,
	projectCorrelatedPromptMessage,
	promptAuthorBindingMatchesText,
	purgeAuthorSidecar,
	readAuthorSidecar,
	type PromptAuthorBinding,
	type PromptAuthorDispatchInput,
} from "../../src/server/agent/author-sidecar.ts";
import { readTranscript } from "../../src/server/agent/transcript-reader.ts";
import { buildVisibleMessageSnapshot } from "../../src/server/agent/visible-message-snapshot.ts";
import {
	LOCAL_USER_AUTHOR,
	type BobbitMessage,
	type MessageAuthor,
} from "../../src/shared/message-author.ts";

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-author-sidecar-v2-"));
const stateDir = path.join(rootDir, "state");
const secretsDir = path.join(rootDir, "private-secrets");
const hmacKey = Buffer.alloc(32, 0x42);

function initialize(
	legacyRoot = stateDir,
	privateRoot = secretsDir,
	key = hmacKey,
): void {
	fs.mkdirSync(legacyRoot, { recursive: true });
	initAuthorSidecarDir(legacyRoot, { secretsDir: privateRoot, hmacKey: key });
}

function sidecarPath(sessionId: string, privateRoot = secretsDir): string {
	return path.join(privateRoot, "author-sidecar", `${sessionId}.jsonl`);
}

beforeAll(() => initialize());

afterAll(() => {
	fs.rmSync(rootDir, { recursive: true, force: true });
});

const systemAuthor: MessageAuthor = { kind: "system", id: "system:bobbit", label: "Bobbit" };
const agentAuthor: MessageAuthor = { kind: "agent", id: "session:caller", label: "Caller" };
const systemPrefix = "[System]: ";
const agentPrefix = "[Caller (caller)]: ";

function dispatch(
	promptId: string,
	modelText: string,
	author: MessageAuthor = LOCAL_USER_AUTHOR,
	dispatchedAt = 1_000,
): PromptAuthorDispatchInput {
	return { promptId, modelText, author, dispatchedAt, source: author.kind === "system" ? "system" : author.kind };
}

function transcriptRow(text: string, extras: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		type: "message",
		...extras,
		message: { role: "user", content: [{ type: "text", text }] },
	})}\n`;
}

function echoedBinding(
	promptId: string,
	piText: string,
	author: MessageAuthor,
	modelPrefix?: string,
	messageId = `message-${promptId}`,
): PromptAuthorBinding {
	return {
		schemaVersion: 2,
		type: "prompt-author",
		promptId,
		dispatchedAt: 1_000,
		modelTextDigest: digestPromptModelText(piText),
		source: author.kind === "system" ? "system" : author.kind,
		author,
		...(modelPrefix === undefined ? {} : { modelPrefix }),
		settlement: {
			schemaVersion: 2,
			type: "prompt-author-settlement",
			promptId,
			settledAt: 1_100,
			outcome: "echoed",
			messageId,
		},
	};
}

describe("author sidecar v2 persistence", () => {
	it("stores v2 digest rows in private secrets without prompt plaintext", () => {
		const sessionId = "roundtrip";
		const promptText = "TOP_SECRET_PROMPT_TEXT_must_never_reach_disk";
		expect(appendPromptAuthorDispatch(sessionId, dispatch("p1", promptText, systemAuthor))).toBe(true);
		expect(appendPromptAuthorSettlement(sessionId, {
			promptId: "p1",
			settledAt: 1_100,
			outcome: "echoed",
			messageId: "m1",
			messageTimestamp: 1_050,
		})).toBe(true);

		const digest = digestPromptModelText(promptText);
		expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(readAuthorSidecar(sessionId)).toEqual([{
			schemaVersion: 2,
			type: "prompt-author",
			promptId: "p1",
			dispatchedAt: 1_000,
			modelTextDigest: digest,
			source: "system",
			author: systemAuthor,
			settlement: {
				schemaVersion: 2,
				type: "prompt-author-settlement",
				promptId: "p1",
				settledAt: 1_100,
				outcome: "echoed",
				messageId: "m1",
				messageTimestamp: 1_050,
			},
		}]);

		const persisted = fs.readFileSync(sidecarPath(sessionId), "utf8");
		const rawRows = persisted.trim().split("\n").map((line) => JSON.parse(line));
		expect(persisted).not.toContain(promptText);
		expect(rawRows.every((row) => row.schemaVersion === 2)).toBe(true);
		expect(rawRows[0]).not.toHaveProperty("modelText");
		expect(rawRows[0]).toMatchObject({ modelTextDigest: digest });
		expect(fs.existsSync(path.join(stateDir, "author-sidecar"))).toBe(false);
	});

	it("stores an author-bound prefix and digests the exact Pi text without body plaintext", () => {
		const sessionId = "prefixed-roundtrip";
		const body = "PREFIXED_BODY_SECRET_must_never_reach_disk";
		const piText = `${agentPrefix}${body}`;
		expect(appendPromptAuthorDispatch(sessionId, {
			...dispatch("prefixed", piText, agentAuthor),
			modelPrefix: agentPrefix,
		})).toBe(true);

		const [binding] = readAuthorSidecar(sessionId);
		expect(binding).toMatchObject({
			author: agentAuthor,
			modelPrefix: agentPrefix,
			modelTextDigest: digestPromptModelText(piText),
		});
		expect(promptAuthorBindingMatchesText(binding, piText)).toBe(true);
		expect(promptAuthorBindingMatchesText(binding, body)).toBe(false);
		const persisted = fs.readFileSync(sidecarPath(sessionId), "utf8");
		expect(persisted).not.toContain(body);
		expect(JSON.parse(persisted)).toMatchObject({
			modelPrefix: agentPrefix,
			modelTextDigest: digestPromptModelText(piText),
		});
	});

	it("accepts only exact formatter-derived prefixes bound to the record author", () => {
		const exactCases = [
			["system", systemAuthor, systemPrefix],
			["agent", agentAuthor, agentPrefix],
		] as const;
		for (const [name, author, modelPrefix] of exactCases) {
			expect(appendPromptAuthorDispatch(`valid-prefix-${name}`, {
				...dispatch("valid", `${modelPrefix}body`, author),
				modelPrefix,
			})).toBe(true);
		}

		const invalidCases: Array<[string, MessageAuthor, string]> = [
			["wrong-agent-label", agentAuthor, "[Other (caller)]: "],
			["wrong-agent-id", agentAuthor, "[Caller (other1)]: "],
			["agent-as-system", agentAuthor, systemPrefix],
			["system-as-agent", systemAuthor, agentPrefix],
			["user-prefix", LOCAL_USER_AUTHOR, "[User (local)]: "],
			["missing-space", systemAuthor, "[System]:"],
		];
		for (const [name, author, modelPrefix] of invalidCases) {
			const invalidRecord = {
				schemaVersion: 2 as const,
				type: "prompt-author" as const,
				promptId: "invalid",
				dispatchedAt: 1_000,
				modelTextDigest: digestPromptModelText(`${modelPrefix}body`) ?? "",
				source: author.kind === "system" ? "system" as const : author.kind,
				author,
				modelPrefix,
			};
			expect(appendPromptAuthorDispatch(`invalid-prefix-${name}`, {
				...dispatch("invalid", `${modelPrefix}body`, author),
				modelPrefix,
			})).toBe(false);
			expect(readAuthorSidecar(`invalid-prefix-${name}`)).toEqual([]);
			expect(foldAuthorSidecarRecords([invalidRecord])).toEqual([]);
		}
	});

	it("enforces POSIX 0700 directory and 0600 ledger modes", () => {
		if (process.platform === "win32") return;
		const sessionId = "posix-modes";
		expect(appendPromptAuthorDispatch(sessionId, dispatch("p1", "mode check"))).toBe(true);
		expect(fs.statSync(path.join(secretsDir, "author-sidecar")).mode & 0o777).toBe(0o700);
		expect(fs.statSync(sidecarPath(sessionId)).mode & 0o777).toBe(0o600);
	});

	it("confines canonical network-derived metadata to a digest-only private ledger", () => {
		const sessionId = "../../network\r\nsession";
		const safeSessionId = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
		const promptText = "UNTRUSTED_NETWORK_PROMPT_must_be_hashed";
		const injectedExtra = "UNTRUSTED_EXTRA_FIELD_must_be_dropped";
		const networkAuthor = {
			kind: "system",
			id: "system:network",
			label: "Network request",
			uploadedBody: injectedExtra,
		} as MessageAuthor;
		expect(appendPromptAuthorDispatch(sessionId, dispatch("network-prompt", promptText, networkAuthor))).toBe(true);

		const ledgerRoot = path.join(secretsDir, "author-sidecar");
		const ledger = sidecarPath(safeSessionId);
		expect(path.dirname(ledger)).toBe(ledgerRoot);
		expect(path.relative(ledgerRoot, ledger)).not.toMatch(/^(?:\.\.[/\\]|[/\\])/);
		const persisted = fs.readFileSync(ledger, "utf8");
		const [record] = persisted.trim().split("\n").map((line) => JSON.parse(line));
		expect(record).toEqual({
			schemaVersion: 2,
			type: "prompt-author",
			promptId: "network-prompt",
			dispatchedAt: 1_000,
			modelTextDigest: digestPromptModelText(promptText),
			source: "system",
			author: { kind: "system", id: "system:network", label: "Network request" },
		});
		expect(persisted).not.toContain(promptText);
		expect(persisted).not.toContain(injectedExtra);
	});

	it("keeps settled digest correlation stable when re-initialized with the same key", () => {
		const sessionId = "same-key-reinit";
		const text = "stable restart correlation";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", text, systemAuthor));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 1_100, outcome: "echoed" });
		const before = readAuthorSidecar(sessionId)[0].modelTextDigest;

		initialize(stateDir, secretsDir, Buffer.from(hmacKey));

		const [binding] = readAuthorSidecar(sessionId);
		expect(binding.modelTextDigest).toBe(before);
		expect(promptAuthorBindingMatchesText(binding, text)).toBe(true);
		const [row] = mergeAuthorSidecarIntoMessages([binding], [{ role: "user", content: text }]);
		expect(row.author).toEqual(systemAuthor);
	});

	it("latest redispatch resets an older settlement for the same prompt id", () => {
		const sessionId = "redispatch";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "first", LOCAL_USER_AUTHOR, 100));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 110, outcome: "cancelled" });
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "second", systemAuthor, 200));
		const [binding] = readAuthorSidecar(sessionId);
		expect(binding.modelText).toBeUndefined();
		expect(promptAuthorBindingMatchesText(binding, "second")).toBe(true);
		expect(promptAuthorBindingMatchesText(binding, "first")).toBe(false);
		expect(binding.author).toEqual(systemAuthor);
		expect(binding.settlement).toBeUndefined();
	});

	it("skips malformed, invalid-author, future-version, and orphan-settlement lines", () => {
		const sessionId = "corrupt";
		appendPromptAuthorDispatch(sessionId, dispatch("valid", "kept"));
		const file = sidecarPath(sessionId);
		const valid = JSON.parse(fs.readFileSync(file, "utf8").trim());
		fs.appendFileSync(file, [
			"not json",
			JSON.stringify({ ...valid, schemaVersion: 3, promptId: "future" }),
			JSON.stringify({ ...valid, promptId: "bad", author: { kind: "tool", id: "x", label: "x" } }),
			JSON.stringify({ schemaVersion: 2, type: "prompt-author-settlement", promptId: "orphan", settledAt: 1, outcome: "echoed" }),
		].join("\n") + "\n");
		expect(readAuthorSidecar(sessionId).map((entry) => entry.promptId)).toEqual(["valid"]);
	});

	it("missing sidecars are empty and invalid appends do not write", () => {
		expect(readAuthorSidecar("missing")).toEqual([]);
		expect(appendPromptAuthorDispatch("invalid", { ...dispatch("", "text"), promptId: "" })).toBe(false);
		expect(readAuthorSidecar("invalid")).toEqual([]);
	});

	it("uses a static format with escaped and bounded read-failure diagnostics", () => {
		const sessionId = `diagnostic\r\n[forged]%s${"x".repeat(600)}`;
		const safeSessionId = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
		const unreadableLedger = sidecarPath(safeSessionId);
		fs.mkdirSync(unreadableLedger);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(readAuthorSidecar(sessionId)).toEqual([]);
			expect(warning).toHaveBeenCalledOnce();
			const [format, sessionDiagnostic, errorDiagnostic] = warning.mock.calls[0];
			expect(format).toBe("[author-sidecar] Read failed for session %s: %s");
			expect(sessionDiagnostic).toBe(JSON.stringify(sessionId).slice(0, 512));
			expect(sessionDiagnostic).not.toMatch(/[\r\n]/);
			expect(String(sessionDiagnostic).length).toBeLessThanOrEqual(512);
			expect(errorDiagnostic).not.toMatch(/[\r\n]/);
			expect(String(errorDiagnostic).length).toBeLessThanOrEqual(512);
		} finally {
			warning.mockRestore();
			fs.rmSync(unreadableLedger, { recursive: true, force: true });
		}
	});

	it("migrates valid v1 rows from a corrupt partial ledger and removes the plaintext source", () => {
		const migrationRoot = path.join(rootDir, "migration-case");
		const legacyState = path.join(migrationRoot, "state");
		const privateRoot = path.join(migrationRoot, "private-secrets");
		const legacyDir = path.join(legacyState, "author-sidecar");
		const legacyFile = path.join(legacyDir, "legacy-session.jsonl");
		const plaintext = "LEGACY_PLAINTEXT_PROMPT_remove_me";
		const invalidPlaintext = "INVALID_LEGACY_PLAINTEXT_ignore_me";
		const futurePlaintext = "FUTURE_LEGACY_PLAINTEXT_ignore_me";
		const partialPlaintext = "PARTIAL_LEGACY_PLAINTEXT_ignore_me";
		const validDispatch = {
			schemaVersion: 1,
			type: "prompt-author",
			...dispatch("legacy-prompt", plaintext, systemAuthor, 500),
		};
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(legacyFile, [
			JSON.stringify(validDispatch),
			"not-json",
			JSON.stringify({
				...validDispatch,
				promptId: "invalid-author",
				modelText: invalidPlaintext,
				author: { kind: "tool", id: "tool:invalid", label: "Invalid" },
			}),
			JSON.stringify({
				...validDispatch,
				schemaVersion: 3,
				promptId: "future-version",
				modelText: futurePlaintext,
			}),
			JSON.stringify({
				schemaVersion: 1,
				type: "prompt-author-settlement",
				promptId: "legacy-prompt",
				settledAt: 550,
				outcome: "echoed",
				messageId: "legacy-message",
			}),
			`{"schemaVersion":1,"type":"prompt-author","promptId":"partial","modelText":"${partialPlaintext}`,
		].join("\n"));

		try {
			initialize(legacyState, privateRoot, hmacKey);
			const migratedText = fs.readFileSync(sidecarPath("legacy-session", privateRoot), "utf8");
			const migratedRows = migratedText.trim().split("\n").map((line) => JSON.parse(line));
			const digest = digestPromptModelText(plaintext);
			expect(migratedRows).toEqual([
				{
					schemaVersion: 2,
					type: "prompt-author",
					promptId: "legacy-prompt",
					dispatchedAt: 500,
					modelTextDigest: digest,
					source: "system",
					author: systemAuthor,
				},
				{
					schemaVersion: 2,
					type: "prompt-author-settlement",
					promptId: "legacy-prompt",
					settledAt: 550,
					outcome: "echoed",
					messageId: "legacy-message",
				},
			]);
			expect(migratedRows.every((row) => !Object.hasOwn(row, "modelText"))).toBe(true);
			expect(migratedRows.every((row) => !Object.hasOwn(row, "modelPrefix"))).toBe(true);
			for (const leakedText of [plaintext, invalidPlaintext, futurePlaintext, partialPlaintext]) {
				expect(migratedText).not.toContain(leakedText);
			}

			const [binding] = readAuthorSidecar("legacy-session");
			expect(binding).toMatchObject({
				schemaVersion: 2,
				promptId: "legacy-prompt",
				modelTextDigest: digest,
				author: systemAuthor,
				settlement: { schemaVersion: 2, outcome: "echoed", messageId: "legacy-message" },
			});
			expect(binding.modelText).toBeUndefined();
			expect(promptAuthorBindingMatchesText(binding, plaintext)).toBe(true);
			const [correlated] = mergeAuthorSidecarIntoMessages([binding], [{ role: "user", content: plaintext }]);
			expect(correlated.author).toEqual(systemAuthor);
			expect(fs.existsSync(legacyFile)).toBe(false);
			expect(fs.existsSync(legacyDir)).toBe(false);
		} finally {
			initialize();
		}
	});

	it("canonicalizes legacy-location v2 rows so extra plaintext cannot reach private storage", () => {
		const migrationRoot = path.join(rootDir, "migration-v2-extra-plaintext");
		const legacyState = path.join(migrationRoot, "state");
		const privateRoot = path.join(migrationRoot, "private-secrets");
		const legacyDir = path.join(legacyState, "author-sidecar");
		const legacyFile = path.join(legacyDir, "legacy-v2-session.jsonl");
		const plaintext = "EXTRA_V2_MODELTEXT_PLAINTEXT_remove_me";
		const nestedAuthorPlaintext = "EXTRA_V2_AUTHOR_MODELTEXT_PLAINTEXT_remove_me";
		const modelTextDigest = digestPromptModelText(`${systemPrefix}canonical v2 prompt`);
		const row = {
			schemaVersion: 2,
			type: "prompt-author",
			promptId: "legacy-v2-prompt",
			dispatchedAt: 700,
			modelTextDigest,
			modelText: plaintext,
			modelPrefix: systemPrefix,
			source: "system",
			author: { ...systemAuthor, modelText: nestedAuthorPlaintext },
		};
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(legacyFile, `${JSON.stringify(row)}\n`);

		try {
			initialize(legacyState, privateRoot, hmacKey);
			const migratedText = fs.readFileSync(sidecarPath("legacy-v2-session", privateRoot), "utf8");
			const migratedRows = migratedText.trim().split("\n").map((line) => JSON.parse(line));
			expect(migratedRows).toEqual([{
				schemaVersion: 2,
				type: "prompt-author",
				promptId: "legacy-v2-prompt",
				dispatchedAt: 700,
				modelTextDigest,
				source: "system",
				author: systemAuthor,
				modelPrefix: systemPrefix,
			}]);
			expect(migratedRows[0].author).toEqual(systemAuthor);
			expect(migratedRows[0]).not.toHaveProperty("modelText");
			expect(migratedRows[0]).not.toHaveProperty("author.modelText");
			expect(migratedText).not.toContain(plaintext);
			expect(migratedText).not.toContain(nestedAuthorPlaintext);
			expect(fs.existsSync(legacyFile)).toBe(false);
		} finally {
			initialize();
		}
	});

	it("resumes a crash-left claimed legacy ledger during startup migration", () => {
		const migrationRoot = path.join(rootDir, "migration-claimed-file");
		const legacyState = path.join(migrationRoot, "state");
		const privateRoot = path.join(migrationRoot, "private-secrets");
		const legacyDir = path.join(legacyState, "author-sidecar");
		const sessionId = "crash-session";
		const claimedFile = path.join(legacyDir, `.${sessionId}.jsonl.migrating`);
		const plaintext = "CRASH_LEFT_CLAIMED_PLAINTEXT_remove_me";
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(claimedFile, `${JSON.stringify({
			schemaVersion: 1,
			type: "prompt-author",
			...dispatch("claimed-prompt", plaintext, systemAuthor, 800),
		})}\n`);

		try {
			initialize(legacyState, privateRoot, hmacKey);
			const migratedText = fs.readFileSync(sidecarPath(sessionId, privateRoot), "utf8");
			const migratedRows = migratedText.trim().split("\n").map((line) => JSON.parse(line));
			const [binding] = readAuthorSidecar(sessionId);
			expect(binding).toMatchObject({
				schemaVersion: 2,
				promptId: "claimed-prompt",
				modelTextDigest: digestPromptModelText(plaintext),
				author: systemAuthor,
			});
			expect(migratedRows.every((row) => !Object.hasOwn(row, "modelText"))).toBe(true);
			expect(migratedText).not.toContain(plaintext);
			expect(fs.existsSync(claimedFile)).toBe(false);
			expect(fs.existsSync(legacyDir)).toBe(false);
		} finally {
			initialize();
		}
	});

	it("does not copy a message-id binding by claiming an older same-text transcript row", () => {
		const source = "copy-message-id-source";
		const destination = "copy-message-id-destination";
		const text = "same text from an older turn";
		appendPromptAuthorDispatch(source, dispatch("newer-prompt", text, agentAuthor, 200));
		appendPromptAuthorSettlement(source, {
			promptId: "newer-prompt",
			settledAt: 210,
			outcome: "echoed",
			messageId: "newer-echo-not-cloned",
		});

		const transcript = transcriptRow(text, { id: "older-echo", timestamp: 100 });
		expect(copyAuthorSidecar(source, destination, { transcript })).toBe(true);
		expect(readAuthorSidecar(destination)).toEqual([]);
		expect(fs.existsSync(sidecarPath(destination))).toBe(false);
	});

	it("copies only echoed bindings confirmed by the cloned transcript, preserving prefixes, then purges", () => {
		const source = "copy-source";
		appendPromptAuthorDispatch(source, {
			...dispatch("settled-present", `${agentPrefix}copy me`, agentAuthor, 100),
			modelPrefix: agentPrefix,
		});
		appendPromptAuthorSettlement(source, {
			promptId: "settled-present", settledAt: 110, outcome: "echoed", messageId: "message-present",
		});
		appendPromptAuthorDispatch(source, dispatch("unresolved-present", "unresolved", systemAuthor, 200));
		appendPromptAuthorDispatch(source, dispatch("settled-absent", "not cloned", systemAuthor, 300));
		appendPromptAuthorSettlement(source, {
			promptId: "settled-absent", settledAt: 310, outcome: "echoed", messageId: "message-absent",
		});
		appendPromptAuthorDispatch(source, dispatch("cancelled-present", "cancelled", systemAuthor, 400));
		appendPromptAuthorSettlement(source, {
			promptId: "cancelled-present", settledAt: 410, outcome: "cancelled",
		});

		const transcript = [
			transcriptRow(`${agentPrefix}copy me`, { id: "message-present" }),
			transcriptRow("unresolved"),
			transcriptRow("cancelled"),
		].join("");
		expect(copyAuthorSidecar(source, "copy-destination", { transcript })).toBe(true);
		const copied = readAuthorSidecar("copy-destination");
		expect(copied).toHaveLength(1);
		expect(copied[0]).toMatchObject({
			schemaVersion: 2,
			promptId: "settled-present",
			author: agentAuthor,
			modelPrefix: agentPrefix,
			settlement: { schemaVersion: 2, outcome: "echoed", messageId: "message-present" },
		});
		expect(promptAuthorBindingMatchesText(copied[0], `${agentPrefix}copy me`)).toBe(true);
		expect(promptAuthorBindingMatchesText(copied[0], "copy me")).toBe(false);
		expect(fs.readFileSync(sidecarPath("copy-destination"), "utf8")).not.toContain("copy me");
		purgeAuthorSidecar("copy-destination");
		expect(readAuthorSidecar("copy-destination")).toEqual([]);
	});
});

describe("author sidecar prefix projection", () => {
	it("removes one exact prefix from raw string content and is replay-safe across stable-id clones", () => {
		const piText = `${systemPrefix}${systemPrefix}hello`;
		const binding = echoedBinding("prefix-shaped", piText, systemAuthor, systemPrefix, "stable-message");
		const raw = { id: "stable-message", role: "user", content: piText };
		const rawClone = structuredClone(raw);

		const [projected] = mergeAuthorSidecarIntoMessages([binding], [raw]);
		expect(projected).toEqual({
			id: "stable-message",
			role: "user",
			content: `${systemPrefix}hello`,
			author: systemAuthor,
		});
		const projectedClones = [
			{ ...projected },
			structuredClone(projected),
			JSON.parse(JSON.stringify(projected)),
		];
		for (const clone of projectedClones) {
			const [replayed] = mergeAuthorSidecarIntoMessages([binding], [clone]);
			expect(replayed.content).toBe(`${systemPrefix}hello`);
			expect(replayed.author).toEqual(systemAuthor);
		}

		const [projectedRawClone] = mergeAuthorSidecarIntoMessages([binding], [rawClone]);
		expect(projectedRawClone.content).toBe(`${systemPrefix}hello`);
		expect(projectedRawClone.author).toEqual(systemAuthor);
	});

	it("proves the concatenated raw digest before cloning only the first prefixed text block", () => {
		const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const firstText = { type: "text", text: `${agentPrefix}hello`, marker: "first" };
		const secondText = { type: "text", text: " world", marker: "second" };
		const unrelated = { type: "metadata", value: 42 };
		const content = [image, firstText, secondText, unrelated];
		const binding = echoedBinding(
			"structured",
			`${agentPrefix}hello world`,
			agentAuthor,
			agentPrefix,
		);

		const projected = projectCorrelatedPromptMessage({ role: "user", content }, binding);
		expect(projected.author).toEqual(agentAuthor);
		expect(projected.content).not.toBe(content);
		const projectedContent = projected.content as typeof content;
		expect(projectedContent[0]).toBe(image);
		expect(projectedContent[1]).not.toBe(firstText);
		expect(projectedContent[1]).toEqual({ ...firstText, text: "hello" });
		expect(projectedContent[2]).toBe(secondText);
		expect(projectedContent[3]).toBe(unrelated);
		expect(extractPromptModelText(projected)).toBe("hello world");
	});

	it("does not strip when an exact prefix is split across text blocks", () => {
		const content = [
			{ type: "image", data: "image" },
			{ type: "text", text: "[Sys" },
			{ type: "text", text: "tem]: body" },
		];
		const binding = echoedBinding("split-prefix", `${systemPrefix}body`, systemAuthor, systemPrefix);
		const projected = projectCorrelatedPromptMessage({ role: "user", content }, binding);
		expect(projected.author).toEqual(systemAuthor);
		expect(projected.content).toBe(content);
	});

	it("stamps correlated authors but preserves content on digest mismatch or absent legacy proof", () => {
		const binding = echoedBinding("mismatch", `${systemPrefix}raw`, systemAuthor, systemPrefix);
		const mismatchContent = [{ type: "text", text: `${systemPrefix}already projected` }];
		const mismatch = projectCorrelatedPromptMessage(
			{ role: "user", content: mismatchContent },
			binding,
		);
		expect(mismatch.author).toEqual(systemAuthor);
		expect(mismatch.content).toBe(mismatchContent);

		const legacyContent = `${systemPrefix}literal legacy text`;
		const legacy = projectCorrelatedPromptMessage(
			{ role: "user", content: legacyContent },
			{ author: systemAuthor, modelPrefix: systemPrefix, modelTextDigest: undefined },
		);
		expect(legacy.author).toEqual(systemAuthor);
		expect(legacy.content).toBe(legacyContent);

		const noPrefixBinding = echoedBinding("no-prefix", legacyContent, systemAuthor);
		const noPrefix = projectCorrelatedPromptMessage(
			{ role: "user", content: legacyContent },
			noPrefixBinding,
		);
		expect(noPrefix.author).toEqual(systemAuthor);
		expect(noPrefix.content).toBe(legacyContent);
	});

	it("rejects semantically invalid binding prefixes before stable-id attribution or stripping", () => {
		const raw = { id: "invalid-binding-message", role: "user", content: `${systemPrefix}literal` };
		const invalid = {
			...echoedBinding(
				"invalid-binding",
				raw.content,
				agentAuthor,
				systemPrefix,
				"invalid-binding-message",
			),
			modelPrefix: systemPrefix,
		};
		const [projected] = mergeAuthorSidecarIntoMessages([invalid], [raw]);
		expect(projected.author).toEqual(LOCAL_USER_AUTHOR);
		expect(projected.content).toBe(raw.content);
	});

	it("keeps repeated prefixed occurrences correlated to their distinct authors", () => {
		const systemPiText = `${systemPrefix}same base`;
		const agentPiText = `${agentPrefix}same base`;
		const bindings = [
			echoedBinding("repeat-system", systemPiText, systemAuthor, systemPrefix),
			{ ...echoedBinding("repeat-agent", agentPiText, agentAuthor, agentPrefix), dispatchedAt: 2_000 },
		];
		const rows = mergeAuthorSidecarIntoMessages(bindings, [
			{ role: "user", content: systemPiText },
			{ role: "user", content: agentPiText },
		]);
		expect(rows.map((row) => [row.content, row.author])).toEqual([
			["same base", systemAuthor],
			["same base", agentAuthor],
		]);
	});

	it("returns full stream bindings and includes prefix bytes in the resolver bound", () => {
		const piText = `${agentPrefix}streamed`;
		const binding = echoedBinding("stream", piText, agentAuthor, agentPrefix, "stream-message");
		const row = { id: "stream-message", role: "user", content: piText };
		const correlation = createPromptAuthorStreamCorrelation([binding]);
		correlation.reserve(row, 0);
		expect(correlation.resolveBinding(row, 0)).toBe(binding);

		const withoutPrefix: PromptAuthorBinding = { ...binding };
		delete withoutPrefix.modelPrefix;
		const baseBytes = 128
			+ Buffer.byteLength(binding.promptId)
			+ Buffer.byteLength(binding.modelTextDigest ?? "")
			+ Buffer.byteLength(binding.source)
			+ Buffer.byteLength(binding.author.id)
			+ Buffer.byteLength(binding.author.label)
			+ Buffer.byteLength(binding.settlement?.messageId ?? "");
		expect(createPromptAuthorStreamCorrelation([withoutPrefix], { maxBindingBytes: baseBytes }).degraded).toBe(false);
		expect(createPromptAuthorStreamCorrelation([binding], { maxBindingBytes: baseBytes }).degraded).toBe(true);
	});
});

describe("author sidecar v2 correlation", () => {
	it("excludes cancelled dispatches and falls back to legacy local-user inference", () => {
		const sessionId = "cancelled";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 1_100, outcome: "cancelled" });
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[{ role: "user", content: "same" }],
			{ session: { id: "target", title: "Target" } },
		);
		expect(rows[0].author).toEqual(LOCAL_USER_AUTHOR);
	});

	it.each([
		["system", systemAuthor],
		["agent", agentAuthor],
	] as const)("does not let an unresolved %s dispatch relabel an older same-text human row", async (_kind, author) => {
		const sessionId = `unresolved-${author.kind}`;
		const text = "same text as a pending dispatch";
		appendPromptAuthorDispatch(sessionId, dispatch(`pending-${author.kind}`, text, author));
		const legacyRows: BobbitMessage<{ id: string; role: string; content: string }>[] = [
			{ id: `legacy-${author.kind}`, role: "user", content: text },
		];

		const merged = mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), legacyRows);
		expect(merged[0].author).toEqual(LOCAL_USER_AUTHOR);

		const snapshot = buildVisibleMessageSnapshot(legacyRows, {
			sessionId,
			session: { id: sessionId, title: "Target" },
		});
		expect(snapshot[0].author).toEqual(LOCAL_USER_AUTHOR);

		const transcript = await readTranscript({}, {
			readContent: async () => transcriptRow(text, { id: `legacy-${author.kind}` }),
			authorContext: {
				session: { id: sessionId, title: "Target" },
				sidecarEntries: readAuthorSidecar(sessionId),
			},
		});
		expect(transcript.messages[0].author).toEqual(LOCAL_USER_AUTHOR);
	});

	it("consumes settled duplicate identical prompt digests FIFO", () => {
		const sessionId = "duplicates";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor, 100));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 110, outcome: "echoed" });
		appendPromptAuthorDispatch(sessionId, dispatch("p2", "same", agentAuthor, 200));
		appendPromptAuthorSettlement(sessionId, { promptId: "p2", settledAt: 210, outcome: "echoed" });
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[{ role: "user", content: "same" }, { role: "user", content: "same" }],
		);
		expect(rows.map((row) => row.author)).toEqual([systemAuthor, agentAuthor]);
	});

	it("reserves an exact id binding before FIFO digest matching", () => {
		const sessionId = "id-priority";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor, 100));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 110, outcome: "echoed", messageId: "m1" });
		appendPromptAuthorDispatch(sessionId, dispatch("p2", "same", agentAuthor, 200));
		appendPromptAuthorSettlement(sessionId, { promptId: "p2", settledAt: 210, outcome: "echoed", messageId: "m2" });
		const rows = mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), [
			{ role: "user", content: "same" },
			{ id: "m2", role: "user", content: "same" },
		]);
		expect(rows.map((row) => row.author)).toEqual([systemAuthor, agentAuthor]);
	});

	it("uses timestamp plus exact digest to disambiguate a retained compacted duplicate", () => {
		const sessionId = "timestamp-priority";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "same", systemAuthor, 1_000));
		appendPromptAuthorSettlement(sessionId, {
			promptId: "p1", settledAt: 1_100, outcome: "echoed", messageTimestamp: 1_050,
		});
		appendPromptAuthorDispatch(sessionId, dispatch("p2", "same", agentAuthor, 10_000));
		appendPromptAuthorSettlement(sessionId, {
			promptId: "p2", settledAt: 10_100, outcome: "echoed", messageTimestamp: 10_050,
		});
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[{ role: "user", content: "same", timestamp: 10_100 }],
		);
		expect(rows[0].author).toEqual(agentAuthor);
	});

	it("correlates the exact Pi text sequence across adjacent text blocks without rewriting content", () => {
		const sessionId = "split-text-blocks";
		const content = [
			{ type: "text", text: "abc" },
			{ type: "text", text: "def" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		];
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "abcdef", systemAuthor));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 1_100, outcome: "echoed" });

		expect(extractPromptModelText({ role: "user", content })).toBe("abcdef");
		const [row] = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[{ role: "user", content }],
		);
		expect(row.author).toEqual(systemAuthor);
		expect(row.content).toBe(content);
		expect(row.content).toEqual(content);
	});

	it("does not claim provider-history user-role tool result blocks", () => {
		const sessionId = "tool-result";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "result", systemAuthor));
		appendPromptAuthorSettlement(sessionId, { promptId: "p1", settledAt: 1_100, outcome: "echoed" });
		const toolResultContent = [{ type: "tool_result", content: "result" }];
		const rows = mergeAuthorSidecarIntoMessages(
			readAuthorSidecar(sessionId),
			[
				{ role: "assistant", content: "called tool" },
				{ role: "user", content: toolResultContent },
			],
			{ session: { id: "target", title: "Target" } },
		);
		expect(rows[1].author).toEqual({ kind: "agent", id: "session:target", label: "Target" });
		expect(rows[1].author?.kind).not.toBe("tool");
		expect(rows[1].content).toBe(toolResultContent);
	});

	it("is idempotent after authors have been merged", () => {
		const sessionId = "idempotent";
		appendPromptAuthorDispatch(sessionId, dispatch("p1", "hello", systemAuthor));
		const first = mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), [{ role: "user", content: "hello" }]);
		const second = mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), first);
		expect(second).toBe(first);
	});
});

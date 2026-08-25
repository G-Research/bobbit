import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ToolManager } from "../../src/server/agent/tool-manager.js";
import { computeToolActivationArgs, tagAllowedTools } from "../../src/server/agent/tool-activation.js";
import {
	persistUploadedAttachmentOccurrence,
	setUploadedAttachmentRootForTesting,
} from "../../src/server/agent/uploaded-attachment-store.js";
import { handleUploadedAttachmentToolRoute } from "../../src/server/uploaded-attachment-routes.js";
import { createUploadedAttachmentExtension } from "../../defaults/tools/attachments/extension.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("uploaded attachment remote-agent tool integration", () => {
	let temp: string;
	const oldEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-attachment-tool-"));
		for (const key of ["BOBBIT_DIR", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL", "BOBBIT_SESSION_ID", "BOBBIT_SESSION_SECRET"]) oldEnv[key] = process.env[key];
		process.env.BOBBIT_DIR = temp;
		process.env.BOBBIT_TOKEN = "gateway-token";
		process.env.BOBBIT_GATEWAY_URL = "http://127.0.0.1:1";
		process.env.BOBBIT_SESSION_ID = SESSION_ID;
		process.env.BOBBIT_SESSION_SECRET = "session-secret";
		setUploadedAttachmentRootForTesting(path.join(temp, "uploaded-attachments"));
	});

	afterEach(() => {
		setUploadedAttachmentRootForTesting(undefined);
		for (const [key, value] of Object.entries(oldEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(temp, { recursive: true, force: true });
	});

	it("is discovered by the real YAML registry and activated for an allowed session", () => {
		const configDir = path.join(temp, "config");
		fs.mkdirSync(configDir, { recursive: true });
		const builtinTools = path.resolve("defaults", "tools");
		const manager = new ToolManager(configDir, builtinTools);
		const provider = manager.getToolProviders().get("session_attachment");
		expect(provider).toMatchObject({ type: "bobbit-extension", extension: "extension.ts" });

		const activation = computeToolActivationArgs(tagAllowedTools(["session_attachment"], manager), manager);
		const attachmentExtensionIndex = activation.args.findIndex((value, index) =>
			activation.args[index - 1] === "--extension" && value.replaceAll("\\", "/").endsWith("/attachments/extension.ts"),
		);
		expect(attachmentExtensionIndex).toBeGreaterThan(0);
	});

	it("registers a callable tool that sends only a session-bound bounded read request", async () => {
		let registered: any;
		let captured: any;
		const extension = createUploadedAttachmentExtension({
			gatewayCall: async (...args: any[]) => {
				captured = args;
				return {
					ok: true,
					status: 200,
					text: "",
					body: {
						operation: "read",
						encoding: "base64",
						data: Buffer.from([0xff, 0x00]).toString("base64"),
						bytesRead: 2,
						nextOffset: 6,
						eof: true,
					},
				};
			},
		});
		extension({ registerTool: (tool: unknown) => { registered = tool; } } as any);
		expect(registered.name).toBe("session_attachment");

		const pointer = `bobbit-attachment:v1:${"a".repeat(64)}:${"b".repeat(64)}:${"c".repeat(24)}`;
		const result = await registered.execute("tool-call", { operation: "read", pointer, offset: 4, length: 2 });
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0].text)).toMatchObject({ encoding: "base64", bytesRead: 2, nextOffset: 6, eof: true });
		expect(captured[1]).toBe("POST");
		expect(captured[2]).toBe(`/api/sessions/${SESSION_ID}/uploaded-attachments/query`);
		expect(captured[3]).toEqual({ operation: "read", pointer, offset: 4, length: 2 });
		expect(captured[4]).toEqual({ extraHeaders: { "X-Bobbit-Session-Secret": "session-secret" } });
		expect(JSON.stringify(captured[3])).not.toContain("gateway-token");
	});

	it("attests the exact live isolated runtime and denies foreign, dead, control, and forged runtimes", async () => {
		const projectId = "attachment-project";
		const siblingId = "22222222-2222-4222-8222-222222222222";
		const ownerContainer = "bobbit-session-owner-live";
		const siblingContainer = "bobbit-session-sibling-live";
		const marker = "ISOLATED_SANDBOX_PRIVATE_MARKER";
		const bytes = Buffer.from(marker);
		const saved = await persistUploadedAttachmentOccurrence(SESSION_ID, "sandbox-occurrence", [{
			id: "sandbox-file",
			type: "document",
			fileName: "private.bin",
			mimeType: "application/octet-stream",
			size: bytes.length,
			content: bytes.toString("base64"),
		}]);
		const pointer = saved.attachments[0].pointer;
		const sessions = new Map<string, any>([
			[SESSION_ID, {
				id: SESSION_ID,
				projectId,
				sandboxed: true,
				containerId: ownerContainer,
				allowedTools: ["session_attachment"],
			}],
			[siblingId, {
				id: siblingId,
				projectId,
				sandboxed: true,
				containerId: siblingContainer,
				allowedTools: ["session_attachment"],
			}],
		]);
		const attestationCalls: Array<[string, string, string]> = [];
		const sandboxManager = {
			isSessionRuntimeIsolated: async (candidateProjectId: string, sessionId: string, containerId: string) => {
				attestationCalls.push([candidateProjectId, sessionId, containerId]);
				await Promise.resolve();
				return candidateProjectId === projectId
					&& ((sessionId === SESSION_ID && containerId === ownerContainer)
						|| (sessionId === siblingId && containerId === siblingContainer));
			},
		};
		let activeSandboxManager: typeof sandboxManager | undefined = sandboxManager;
		let readBodyCalls = 0;
		let rejectBodyReads = false;
		const sessionManager = {
			sessionSecretStore: {
				resolveSessionIdBySecret: (secret: string | undefined) => {
					if (secret === "session-secret") return SESSION_ID;
					if (secret === "sibling-secret") return siblingId;
					return undefined;
				},
			},
			getSession: (sessionId: string) => sessions.get(sessionId),
			getSandboxManager: () => activeSandboxManager,
		};
		const server = http.createServer(async (req, res) => {
			const handled = await handleUploadedAttachmentToolRoute(
				new URL(req.url ?? "/", "http://127.0.0.1"),
				req,
				res,
				{
					sessionManager: sessionManager as any,
					readBody: async (request, maxBytes = 16 * 1024) => {
						readBodyCalls += 1;
						if (rejectBodyReads) throw new Error("runtime rejection must precede body parsing");
						const chunks: Buffer[] = [];
						let total = 0;
						for await (const chunk of request) {
							const buffer = Buffer.from(chunk);
							total += buffer.length;
							if (total > maxBytes) throw new Error("too large");
							chunks.push(buffer);
						}
						return JSON.parse(Buffer.concat(chunks).toString("utf8"));
					},
				},
			);
			if (!handled) {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing test server address");
			const query = async (sessionId: string, secret: string, body: unknown) => {
				const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${sessionId}/uploaded-attachments/query`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Bobbit-Session-Secret": secret,
					},
					body: JSON.stringify(body),
				});
				return { response, text: await response.text() };
			};

			const listed = await query(SESSION_ID, "session-secret", { operation: "list", pointer });
			expect(listed.response.status).toBe(200);
			expect(JSON.parse(listed.text).attachments).toEqual([
				expect.objectContaining({ pointer, fileName: "private.bin", size: bytes.length }),
			]);
			const ranged = await query(SESSION_ID, "session-secret", { operation: "read", pointer, offset: 3, length: 7 });
			expect(ranged.response.status).toBe(200);
			const range = JSON.parse(ranged.text);
			expect(range).toMatchObject({ operation: "read", encoding: "base64", offset: 3, bytesRead: 7 });
			expect(Buffer.from(range.data, "base64")).toEqual(bytes.subarray(3, 10));
			expect(attestationCalls.slice(0, 2)).toEqual([
				[projectId, SESSION_ID, ownerContainer],
				[projectId, SESSION_ID, ownerContainer],
			]);

			// A correctly attested sibling still cannot reuse the owner's pointer.
			const sibling = await query(siblingId, "sibling-secret", { operation: "read", pointer, offset: 0, length: 1 });
			expect(sibling.response.status).toBe(404);
			expect(JSON.parse(sibling.text)).toMatchObject({ code: "UPLOADED_ATTACHMENT_NOT_FOUND", retryable: false });
			expect(sibling.text).not.toContain(marker);
			expect(attestationCalls.at(-1)).toEqual([projectId, siblingId, siblingContainer]);

			rejectBodyReads = true;
			const owner = sessions.get(SESSION_ID);
			const expectUnavailable = async (label: string) => {
				const bodyCallsBefore = readBodyCalls;
				const denied = await query(SESSION_ID, "session-secret", { operation: "read", pointer, offset: 0, length: 1 });
				expect(denied.response.status, label).toBe(403);
				expect(JSON.parse(denied.text)).toEqual({
					error: "Uploaded attachment sandbox runtime is unavailable",
					code: "UPLOADED_ATTACHMENT_SANDBOX_UNAVAILABLE",
					retryable: false,
				});
				expect(readBodyCalls, label).toBe(bodyCallsBefore);
				expect(denied.text).not.toContain(marker);
				expect(denied.text).not.toContain(bytes.toString("base64"));
				expect(denied.text).not.toContain(temp);
			};
			for (const containerId of [
				"wrong-runtime",
				siblingContainer,
				"dead-runtime",
				"bobbit-project-control",
				"forged-client-runtime",
			]) {
				owner.containerId = containerId;
				await expectUnavailable(containerId);
				expect(attestationCalls.at(-1), containerId).toEqual([projectId, SESSION_ID, containerId]);
			}

			owner.containerId = ownerContainer;
			owner.projectId = undefined;
			await expectUnavailable("missing project identity");
			owner.projectId = projectId;
			owner.containerId = undefined;
			await expectUnavailable("missing container identity");
			owner.containerId = ownerContainer;
			activeSandboxManager = undefined;
			await expectUnavailable("missing sandbox manager");
			activeSandboxManager = {
				isSessionRuntimeIsolated: async () => { throw new Error(`attestation failed at ${temp}`); },
			};
			await expectUnavailable("attestation error");

			// Even a positive async result cannot authorize a runtime replaced while
			// the attestation was in flight.
			activeSandboxManager = {
				isSessionRuntimeIsolated: async () => {
					await Promise.resolve();
					sessions.set(SESSION_ID, { ...owner });
					return true;
				},
			};
			await expectUnavailable("replaced live session");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});

	it("preserves exact persisted reads for a non-sandbox session", async () => {
		const bytes = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0xef]);
		const saved = await persistUploadedAttachmentOccurrence(SESSION_ID, "accepted-occurrence", [{
			id: "client-file",
			type: "document",
			fileName: "firmware.odd",
			mimeType: "application/x-firmware",
			size: bytes.length,
			content: bytes.toString("base64"),
		}]);
		const pointer = saved.attachments[0].pointer;
		const sessionManager = {
			sessionSecretStore: {
				resolveSessionIdBySecret: (secret: string | undefined) => secret === "session-secret" ? SESSION_ID : undefined,
			},
			getSession: (sessionId: string) => sessionId === SESSION_ID
				? { id: SESSION_ID, sandboxed: false, allowedTools: ["session_attachment"] }
				: undefined,
		};
		const server = http.createServer(async (req, res) => {
			const handled = await handleUploadedAttachmentToolRoute(
				new URL(req.url ?? "/", "http://127.0.0.1"),
				req,
				res,
				{
					sessionManager: sessionManager as any,
					readBody: async (request, maxBytes = 16 * 1024) => {
						const chunks: Buffer[] = [];
						let total = 0;
						for await (const chunk of request) {
							const buffer = Buffer.from(chunk);
							total += buffer.length;
							if (total > maxBytes) throw new Error("too large");
							chunks.push(buffer);
						}
						return JSON.parse(Buffer.concat(chunks).toString("utf8"));
					},
				},
			);
			if (!handled) {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing test server address");
			process.env.BOBBIT_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
			let registered: any;
			createUploadedAttachmentExtension()({ registerTool: (tool: unknown) => { registered = tool; } } as any);
			const result = await registered.execute("tool-call", { operation: "read", pointer, offset: 1, length: 3 });
			expect(result.isError).not.toBe(true);
			const response = JSON.parse(result.content[0].text);
			expect(response).toMatchObject({ operation: "read", encoding: "base64", bytesRead: 3, nextOffset: 4, eof: false });
			expect(Buffer.from(response.data, "base64")).toEqual(bytes.subarray(1, 4));

			process.env.BOBBIT_SESSION_SECRET = "foreign-secret";
			const rejected = await registered.execute("tool-call-2", { operation: "read", pointer });
			expect(rejected.isError).toBe(true);
			expect(rejected.content[0].text).toContain("forbidden");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	});
});

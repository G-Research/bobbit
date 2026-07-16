import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import type { PackStore } from "../../src/server/extension-host/pack-store.js";
import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { buildGithubReviewPreview } from "../../src/server/pr-walkthrough/export-mapper.js";
import {
	handlePrWalkthroughApiRoute,
	resolveWalkthroughForTesting,
	type PrWalkthroughRouteDeps,
} from "../../src/server/pr-walkthrough/routes.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const LOCAL_DIFF = [
	"diff --git a/README.md b/README.md",
	"index 1111111..2222222 100644",
	"--- a/README.md",
	"+++ b/README.md",
	"@@ -1 +1,2 @@",
	" # Demo",
	"+Second line",
	"diff --git a/src/feature.ts b/src/feature.ts",
	"new file mode 100644",
	"index 0000000..3333333",
	"--- /dev/null",
	"+++ b/src/feature.ts",
	"@@ -0,0 +1 @@",
	"+export const answer = 42;",
	"",
].join("\n");

type GitFixtureRefs = {
	cwd: string;
	projectId: string;
	sessionId: string;
	baseSha: string;
	headSha: string;
};

type StoredResolve = Awaited<ReturnType<typeof resolveWalkthroughForTesting>>;
type JsonBody = Record<string, any>;

type InMemoryProject = { id: string; rootPath: string };
type InMemorySession = { id: string; projectId: string; cwd: string };

class InMemoryPackStore {
	private readonly values = new Map<string, unknown>();

	private id(packId: string, key: string): string {
		return `${packId}\u0000${key}`;
	}

	async get<T = unknown>(packId: string, key: string): Promise<T | null> {
		return (this.values.get(this.id(packId, key)) as T | undefined) ?? null;
	}

	async put<T = unknown>(packId: string, key: string, value: T): Promise<void> {
		this.values.set(this.id(packId, key), value);
	}

	async list(packId: string, prefix = ""): Promise<string[]> {
		const marker = `${packId}\u0000`;
		return [...this.values.keys()]
			.filter(key => key.startsWith(marker) && key.slice(marker.length).startsWith(prefix))
			.map(key => key.slice(marker.length))
			.sort();
	}

	async delete(packId: string, key: string): Promise<boolean> {
		return this.values.delete(this.id(packId, key));
	}

	async deletePrefix(packId: string, prefix: string): Promise<number> {
		const keys = await this.list(packId, prefix);
		for (const key of keys) this.values.delete(this.id(packId, key));
		return keys.length;
	}

	async stats(): Promise<any> {
		return { keys: this.values.size, totalBytes: 0 };
	}

	getSync<T = unknown>(packId: string, key: string): T | null {
		return (this.values.get(this.id(packId, key)) as T | undefined) ?? null;
	}
}

function fakeChild(stdout: string): ReturnType<NonNullable<CommandRunner["spawn"]>> {
	const child = new EventEmitter() as any;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	queueMicrotask(() => {
		child.stdout.end(Buffer.from(stdout));
		child.stderr.end();
		child.emit("close", 0, null);
	});
	return child;
}

class PrWalkthroughRouteFixture {
	readonly packStore = new InMemoryPackStore();
	readonly gitCalls: string[] = [];
	readonly ghCalls: string[] = [];
	private readonly projects = new Map<string, InMemoryProject>();
	private readonly sessions = new Map<string, InMemorySession>();
	private readonly walkthroughs = new Map<string, StoredResolve>();
	private nextId = 1;

	readonly commandRunner: CommandRunner = {
		execFile: async (command, args, options) => {
			if (command === "gh") {
				this.ghCalls.push(args.join(" "));
				throw new Error("[pr-walkthrough-api] gh unavailable in tier-1");
			}
			if (command !== "git") throw new Error(`unexpected command: ${command}`);
			this.assertOwnedCwd(options?.cwd);
			const key = args.join(" ");
			this.gitCalls.push(key);
			if (args[0] === "rev-parse" && args.includes("--verify")) {
				if (key.includes(BASE_SHA)) return { stdout: `${BASE_SHA}\n`, stderr: "" };
				if (key.includes(HEAD_SHA)) return { stdout: `${HEAD_SHA}\n`, stderr: "" };
				throw new Error(`unknown ref: ${key}`);
			}
			if (args.includes("--shortstat")) return { stdout: " 2 files changed, 2 insertions(+)\n", stderr: "" };
			if (args.includes("--name-status")) return { stdout: "M\tREADME.md\nA\tsrc/feature.ts\n", stderr: "" };
			if (args[0] === "diff") return { stdout: LOCAL_DIFF, stderr: "" };
			throw new Error(`unexpected fake git command: ${key}`);
		},
		spawn: (command, args, options) => {
			if (command !== "git" || args[0] !== "diff") {
				throw new Error(`unexpected fake spawn: ${command} ${args.join(" ")}`);
			}
			this.assertOwnedCwd(options?.cwd);
			this.gitCalls.push(args.join(" "));
			return fakeChild(LOCAL_DIFF);
		},
	};

	createLocalFixture(): GitFixtureRefs {
		const id = this.nextId++;
		const project: InMemoryProject = { id: `project-${id}`, rootPath: `C:/memory/pr-walkthrough-${id}` };
		const session: InMemorySession = { id: `session-${id}`, projectId: project.id, cwd: `${project.rootPath}/repo` };
		this.projects.set(project.id, project);
		this.sessions.set(session.id, session);
		return { cwd: session.cwd, projectId: project.id, sessionId: session.id, baseSha: BASE_SHA, headSha: HEAD_SHA };
	}

	async fetch(requestPath: string, init: { method?: string; body?: string } = {}): Promise<Response> {
		const url = new URL(requestPath, "http://pr-walkthrough.local");
		const method = init.method ?? "GET";
		const body = init.body ? JSON.parse(init.body) as JsonBody : undefined;

		if (url.pathname === "/api/pr-walkthrough/resolve" && method === "POST") {
			try {
				const resolved = await resolveWalkthroughForTesting(body ?? {}, this.routeDeps(body));
				this.walkthroughs.set(resolved.changesetId, resolved);
				return json(resolved);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return json({ error: message, message }, /not found|unknown|invalid|missing|required/i.test(message) ? 400 : 500);
			}
		}

		const previewMatch = url.pathname.match(/^\/api\/pr-walkthrough\/(.+)\/export\/preview$/);
		if (previewMatch && method === "POST") {
			const walkthrough = this.walkthroughs.get(decodeURIComponent(previewMatch[1]));
			if (!walkthrough) return json({ error: `Walkthrough not found: ${previewMatch[1]}` }, 404);
			return json(buildGithubReviewPreview(body as any, walkthrough.cards as any, walkthrough.changeset as any));
		}

		const submitMatch = url.pathname.match(/^\/api\/pr-walkthrough\/(.+)\/export\/submit$/);
		if (submitMatch && method === "POST") {
			const walkthrough = this.walkthroughs.get(decodeURIComponent(submitMatch[1]));
			if (!walkthrough) return json({ error: `Walkthrough not found: ${submitMatch[1]}` }, 404);
			if (body?.confirm !== true) {
				return json({
					error: "Explicit confirmation is required before submitting a GitHub review",
					message: "Explicit confirmation is required before submitting a GitHub review",
					code: "CONFIRMATION_REQUIRED",
				}, 400);
			}
			if (walkthrough.export?.provider !== "github" || walkthrough.export.available !== true) {
				return json({ ok: false, error: "GitHub review submission is unavailable for this walkthrough", code: "EXPORT_UNAVAILABLE" }, 400);
			}
			throw new Error("confirmed export is outside this declaration's preview/confirmation contract");
		}

		if (url.pathname === "/api/pr-walkthrough/submit-review" && method === "POST") {
			return this.callProductionPublicRoute(url, body);
		}

		return json({ error: "Route not found" }, 404);
	}

	private routeDeps(body?: JsonBody): PrWalkthroughRouteDeps {
		return {
			defaultCwd: "C:/memory/default",
			readBody: async () => body,
			resolveSessionCwd: sessionId => this.sessions.get(sessionId)?.cwd,
			preferencesStore: { get: () => undefined },
			packStore: this.packStore as unknown as PackStore,
			commandRunner: this.commandRunner,
			noExternal: true,
		};
	}

	private async callProductionPublicRoute(url: URL, body?: JsonBody): Promise<Response> {
		let status = 500;
		let payload: unknown = { error: "route did not respond" };
		const response = {
			writeHead(code: number) {
				status = code;
				return response;
			},
			end(chunk?: string | Buffer) {
				payload = chunk ? JSON.parse(chunk.toString()) : undefined;
				return response;
			},
		} as unknown as ServerResponse;
		const request = { method: "POST", headers: {} } as IncomingMessage;
		const handled = await handlePrWalkthroughApiRoute(url, request, response, this.routeDeps(body));
		expect(handled).toBe(true);
		return json(payload, status);
	}

	private assertOwnedCwd(cwd: unknown): void {
		if (typeof cwd !== "string" || ![...this.sessions.values()].some(session => session.cwd === cwd)) {
			throw new Error(`command escaped suite-owned session cwd: ${String(cwd)}`);
		}
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function resolveLocal(api: PrWalkthroughRouteFixture, fixture: GitFixtureRefs, overrides: Record<string, unknown> = {}): Promise<any> {
	const resp = await api.fetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ sessionId: fixture.sessionId, baseSha: fixture.baseSha, headSha: fixture.headSha, ...overrides }),
	});
	const body = await resp.json();
	expect(resp.status, JSON.stringify(body)).toBe(200);
	return body;
}

async function resolveFixtureWalkthrough(api: PrWalkthroughRouteFixture): Promise<any> {
	const resp = await api.fetch("/api/pr-walkthrough/resolve", {
		method: "POST",
		body: JSON.stringify({ fixture: true }),
	});
	expect(resp.status).toBe(200);
	return resp.json();
}

function firstLineAnchor(result: any): { cardId: string; diffBlockId: string; lineId: string } {
	for (const card of result.cards ?? []) {
		for (const block of card.diffBlocks ?? []) {
			for (const hunk of block.hunks ?? []) {
				const line = (hunk.lines ?? []).find((item: any) => item.newLine || item.oldLine);
				if (line) return { cardId: card.id, diffBlockId: block.id, lineId: line.id };
			}
		}
	}
	throw new Error("resolved walkthrough had no line anchors");
}

const test = Object.assign(it, { describe });

test.describe("PR walkthrough REST API", () => {
	test("POST resolve returns local diff cards from the injected git boundary", async () => {
		const api = new PrWalkthroughRouteFixture();
		const fixture = api.createLocalFixture();
		const result = await resolveLocal(api, fixture);
		expect(result.changesetId).toBe(`${fixture.baseSha.slice(0, 7)}..${fixture.headSha.slice(0, 7)}`);
		expect(result.changeset.provider).toBe("local");
		expect(result.changeset.filesChanged).toBe(2);
		expect(result.cards.length).toBeGreaterThanOrEqual(2);
		expect(result.cards.flatMap((card: any) => card.diffBlocks).some((block: any) => block.filePath === "src/feature.ts")).toBe(true);
		expect(api.gitCalls).toContain(`rev-parse --verify ${BASE_SHA}^{commit}`);
		expect(api.gitCalls).toContain(`rev-parse --verify ${HEAD_SHA}^{commit}`);
	});

	test("export preview maps line comments and submit rejects without explicit confirmation", async () => {
		const api = new PrWalkthroughRouteFixture();
		const result = await resolveFixtureWalkthrough(api);
		const anchor = firstLineAnchor(result);
		const draft = {
			changeset: result.changeset,
			decisions: {},
			completedCardIds: [anchor.cardId],
			updatedAt: new Date().toISOString(),
			comments: [
				{ id: "line-1", ...anchor, body: "Please double-check this line.", source: "custom", createdAt: new Date().toISOString() },
				{ id: "card-1", cardId: anchor.cardId, body: "Card-level concern", source: "custom", createdAt: new Date().toISOString() },
			],
		};

		const previewResp = await api.fetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/preview`, {
			method: "POST",
			body: JSON.stringify(draft),
		});
		expect(previewResp.status).toBe(200);
		const preview = await previewResp.json();
		expect(preview.rows.some((row: any) => row.commentId === "line-1" && row.valid && row.path)).toBe(true);
		expect(preview.body).toContain("Card-level concern");

		const submitResp = await api.fetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
			method: "POST",
			body: JSON.stringify({ draft }),
		});
		expect(submitResp.status).toBe(400);
		const submitBody = await submitResp.json();
		expect(submitBody.code).toBe("CONFIRMATION_REQUIRED");
	});

	// Master #946 dropped the blanket `previewOnly` denial: a with-SHA github target
	// now reports availability from local gh auth. This suite's gh dependency rejects,
	// so the result deterministically takes the actionable no-credentials branch.
	test("GitHub PR resolve faked from local SHAs reports gh-auth availability (no previewOnly)", async () => {
		const api = new PrWalkthroughRouteFixture();
		const fixture = api.createLocalFixture();
		const prUrl = "https://github.com/acme/widgets/pull/42";
		const result = await resolveLocal(api, fixture, { prUrl });
		expect(result.changesetId).toBe(`github:acme/widgets#42:${fixture.headSha.slice(0, 7)}`);
		expect(result.changeset.provider).toBe("github");
		expect(result.changeset.prUrl).toBe(prUrl);
		expect(result.changeset.externalUrl).toBe(prUrl);
		expect(result.export.available).toBe(false);
		expect(result.export.reason).toMatch(/gh auth login/);
		expect(result.export.previewOnly).toBeUndefined();
		expect(api.ghCalls).toEqual(["auth token"]);

		const submitResp = await api.fetch(`/api/pr-walkthrough/${encodeURIComponent(result.changesetId)}/export/submit`, {
			method: "POST",
			body: JSON.stringify({ draft: { comments: [] }, confirm: true }),
		});
		expect(submitResp.status).toBe(400);
		expect((await submitResp.json()).code).toBe("EXPORT_UNAVAILABLE");
	});

	test("bearer-gated public submit-review enforces jobId + trust + confirm before any gh call", async () => {
		const api = new PrWalkthroughRouteFixture();
		const store = api.packStore;
		const PACK_ID = "pr-walkthrough";
		const prUrl = "https://github.com/acme/widgets/pull/42";
		const trustedJob = "prw-submit-review-trusted";
		const untrustedJob = "prw-submit-review-untrusted";
		const changeset = {
			baseSha: "aaaaaaa", headSha: "bbbbbbb", provider: "github", prUrl, externalUrl: prUrl,
			prNumber: 42, prTitle: "Post via gh", title: "PR #42: Post via gh",
		};
		const cards = [{ id: "card-1", phaseId: "significant", title: "Card", summary: "s", diffBlocks: [] }];
		await store.put(PACK_ID, `reviews/${trustedJob}/binding/prw-session-sr-1`, {
			jobId: trustedJob, parentSessionId: "owner-sr-1",
			target: { provider: "github", prUrl, owner: "acme", repo: "widgets", number: 42, host: "github.com", canonicalKey: "github:acme/widgets#42" },
		});
		await store.put(PACK_ID, `reviews/${trustedJob}/final/payload`, { changeset, cards });
		await store.put(PACK_ID, `reviews/${untrustedJob}/binding/prw-session-sr-2`, {
			jobId: untrustedJob, parentSessionId: "owner-sr-2",
			target: { provider: "github", prUrl: "https://github.example.com/acme/widgets/pull/42", owner: "acme", repo: "widgets", number: 42, host: "github.example.com", canonicalKey: "github:github.example.com/acme/widgets#42" },
		});

		const missing = await api.fetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ confirm: true }) });
		expect(missing.status).toBe(400);
		expect((await missing.json()).code).toBe("INVALID_SUBMIT_REVIEW_REQUEST");

		const unknown = await api.fetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: "prw-nope", confirm: true }) });
		expect(unknown.status).toBe(404);
		expect((await unknown.json()).code).toBe("WALKTHROUGH_NOT_BOUND");

		const untrusted = await api.fetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: untrustedJob, confirm: true, draft: { comments: [] } }) });
		expect(untrusted.status).toBe(403);
		expect((await untrusted.json()).code).toBe("untrusted_github_host");

		const noConfirm = await api.fetch("/api/pr-walkthrough/submit-review", { method: "POST", body: JSON.stringify({ jobId: trustedJob, draft: { comments: [] } }) });
		expect(noConfirm.status).toBe(400);
		expect((await noConfirm.json()).code).toBe("CONFIRMATION_REQUIRED");
		expect(api.ghCalls).toEqual([]);
	});
});

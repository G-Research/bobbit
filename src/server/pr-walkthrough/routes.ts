import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { bobbitStateDir } from "../bobbit-dir.js";
import type { SandboxScope } from "../auth/sandbox-token.js";
import { completeModelText as defaultCompleteModelText } from "../agent/model-completion.js";
import { getAvailableModels as defaultGetAvailableModels, type ApiModel } from "../agent/model-registry.js";
import { safeExternalUrl, normalizeTrustedHosts, isTrustedExternalHost } from "../../shared/pr-walkthrough/url-safety.js";
import { deriveNavLabel } from "../../shared/pr-walkthrough/nav-label.js";
import type { PrWalkthroughCardSection } from "../../shared/pr-walkthrough/types.js";
import type { WalkthroughSessionManagerLike } from "./walkthrough-agent-manager.js";
import { WalkthroughAnalysisBundleStore, createAnalysisBundleFromParsedDiff, type ReadPrWalkthroughBundleRequest } from "./walkthrough-analysis-bundle.js";
import { resolveGithubPr } from "./github-adapter.js";
import { resolveLocalChangeset } from "./git-changeset.js";
import { validatePrWalkthroughYaml, type WalkthroughParsedDiffForYamlMapping } from "./walkthrough-yaml-schema.js";
import type { PrWalkthroughJobRecord, PrWalkthroughTarget } from "./walkthrough-agent-store.js";
import { getPackStore, type PackStore } from "../extension-host/pack-store.js";
import type { OrchestrationCore } from "../agent/orchestration-core.js";
import type { SessionSecretStore } from "../auth/session-secret.js";

// ── host.agents reviewer migration (design Decisions C/D/E) ──
// The pack-store packId for the builtin pr-walkthrough pack. The submit-yaml +
// bundle SERVER routes reach the pack-scoped store with this constant id (the same
// store `ctx.host.store` delegates to in the confined worker). If the builtin
// pack's server-derived id ever diverges from its directory name this lookup
// breaks — see design Risk #2.
const PRW_PACK_ID = "pr-walkthrough";
// Single source for the terminal binding statuses (mirrors lib/routes.mjs).
const PRW_TERMINAL_STATUSES = new Set(["submitted", "ready", "error"]);
const prwBindingKey = (childSessionId: string): string => `binding/${childSessionId}`;
const prwSubmittedKey = (jobId: string): string => `submitted/${jobId}`;

const execFile = promisify(execFileCb);
const STORE_SCHEMA_VERSION = 1;

type JsonReader = (req: http.IncomingMessage) => Promise<any>;

type WalkthroughWarning = {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
};

type DiffLine = {
	id: string;
	side: "old" | "new" | "context";
	oldLine?: number;
	newLine?: number;
	text: string;
	kind: "context" | "add" | "del";
};

type DiffHunk = { id: string; header: string; lines: DiffLine[] };
type DiffBlock = { id: string; filePath: string; oldPath?: string; status?: string; hunks: DiffHunk[]; externalUrl?: string; blobUrl?: string; rawUrl?: string; contentsUrl?: string };
type WalkthroughCard = {
	id: string;
	phaseId: "orientation" | "design" | "significant" | "other" | "audit";
	title: string;
	summary: string;
	rationale?: string;
	diffBlocks: DiffBlock[];
	checklist?: string[];
	cardSuggestions?: string[];
	suggestedComments?: Array<{ id: string; cardId: string; diffBlockId: string; lineId: string; body: string }>;
	navLabel?: string;
	sections?: PrWalkthroughCardSection[];
};

type WalkthroughChangeset = {
	baseSha: string;
	headSha: string;
	provider?: string;
	externalUrl?: string;
	prUrl?: string;
	prNumber?: string | number;
	prTitle?: string;
	prBody?: string;
	title?: string;
	filesChanged?: number;
	additions?: number;
	deletions?: number;
};

type WalkthroughResolveResult = {
	changesetId: string;
	changeset: WalkthroughChangeset;
	cards: WalkthroughCard[];
	warnings: WalkthroughWarning[];
	limits?: Record<string, unknown>;
	export?: WalkthroughExportCapability;
};

type WalkthroughExportCapability = {
	provider?: string;
	available: boolean;
	reason?: string;
	previewOnly?: boolean;
	[key: string]: unknown;
};

type StoredWalkthrough = {
	schemaVersion: number;
	updatedAt: string;
	payload: WalkthroughResolveResult;
};

export type PrWalkthroughRouteDeps = {
	defaultCwd: string;
	stateDir?: string;
	readBody: JsonReader;
	resolveSessionCwd?: (sessionId: string) => string | undefined | Promise<string | undefined>;
	resolveSessionModel?: (sessionId: string) => string | { provider?: string; id?: string; modelId?: string } | undefined | Promise<string | { provider?: string; id?: string; modelId?: string } | undefined>;
	preferencesStore?: { get(key: string): unknown };
	getAvailableModels?: (preferencesStore: { get(key: string): unknown }) => Promise<ApiModel[]>;
	completeModelText?: typeof defaultCompleteModelText;
	createSynthesisAdapter?: (context: WalkthroughSynthesisContext) => WalkthroughLlmAdapter | undefined | Promise<WalkthroughLlmAdapter | undefined>;
	sessionManager?: WalkthroughSessionManagerLike;
	broadcast?: (event: Record<string, unknown>) => void;
	/** Optional GitHub preflight hook for the binding-routed bundle path (resolves
	 *  trusted-host/credentials before a GitHub fetch). Unused in production today. */
	preflightGithubLaunch?: (job: PrWalkthroughJobRecord) => Promise<void> | void;
	sandboxScope?: SandboxScope;
	// ── host.agents reviewer migration (design Decisions C/D/E) ──
	/** OrchestrationCore — submit-yaml server-dismisses the reviewer child on terminal
	 *  (terminal-synchronous reap, Decision E). */
	orchestrationCore?: OrchestrationCore;
	/** Pack-scoped KV store (process singleton) holding the `binding/`+`submitted/`
	 *  reviewer routing keys written by the pack `run` route. */
	packStore?: PackStore;
	/** Resolves the authentic caller session id from `X-Bobbit-Session-Secret`
	 *  (Decision C — REQUIRED for the binding-routed submit-yaml/bundle paths). */
	sessionSecretStore?: SessionSecretStore;
};

type WalkthroughLlmAdapter = (input: Record<string, unknown>) => Promise<unknown> | unknown;
type WalkthroughSynthesisContext = { sessionId?: string; cwd: string; changeset?: WalkthroughChangeset };
let synthesisAdapterForTesting: WalkthroughLlmAdapter | undefined;
let configuredSynthesisAdapter: WalkthroughLlmAdapter | undefined | null;

export function setPrWalkthroughSynthesisAdapterForTesting(adapter: WalkthroughLlmAdapter | undefined): void {
	synthesisAdapterForTesting = adapter;
}

export async function handlePrWalkthroughApiRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: PrWalkthroughRouteDeps,
): Promise<boolean> {
	const isPublicWalkthroughRoute = url.pathname.startsWith("/api/pr-walkthrough");
	const isInternalSubmitRoute = url.pathname === "/api/internal/pr-walkthrough/submit-yaml";
	const isInternalBundleRoute = url.pathname === "/api/internal/pr-walkthrough/bundle" || url.pathname === "/api/internal/pr-walkthrough/analysis-bundle";
	if (!isPublicWalkthroughRoute && !isInternalSubmitRoute && !isInternalBundleRoute) return false;

	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(data));
	};
	const fail = (status: number, message: string, extra?: Record<string, unknown>) => {
		json({ error: message, message, ...extra }, status);
	};

	try {
		if (isInternalBundleRoute && (req.method === "GET" || req.method === "POST")) {
			const body = req.method === "POST" ? await deps.readBody(req) : undefined;
			const input = bundleReadRequestFrom(url, body);
			// Authoritative caller session id from the REQUIRED session secret (Decision C).
			const authSessionId = verifyCallerSession(req, deps, fail);
			if (!authSessionId) return true;
			if (deps.sandboxScope && !deps.sandboxScope.sessionIds.has(authSessionId)) {
				fail(403, "Forbidden: PR walkthrough bundle read session is outside sandbox scope", { code: "SANDBOX_SESSION_OUT_OF_SCOPE" });
				return true;
			}
			const store = deps.packStore ?? getPackStore();
			const binding = await store.get<PrWalkthroughBinding>(PRW_PACK_ID, prwBindingKey(authSessionId));
			if (!binding || typeof binding !== "object") {
				fail(403, "Caller is not a bound PR-walkthrough reviewer", { code: "WALKTHROUGH_NOT_BOUND", retryable: false });
				return true;
			}
			// FINDING 1 — trusted-host gate (restores assertTrustedGithubTarget) BEFORE
			// any diff resolution, incl. the with-SHA local-recompute path.
			if (!assertTrustedBindingTarget(binding, deps, fail)) return true;
			json(await resolveAndReadBindingBundle(deps, binding, authSessionId, {
				mode: input.mode,
				path: input.path,
				index: input.index,
				offset: input.offset,
				limit: input.limit,
				hunkOffset: input.hunkOffset,
				hunkLimit: input.hunkLimit,
			}));
			return true;
		}

		if (isInternalSubmitRoute && req.method === "POST") {
			const body = await deps.readBody(req);
			if (!body || typeof body !== "object") {
				fail(400, "Invalid YAML submit request");
				return true;
			}
			if (typeof body.yaml !== "string") {
				fail(400, "Missing required field: yaml", { code: "INVALID_SUBMIT_REQUEST" });
				return true;
			}
			// Authoritative caller session id from the REQUIRED session secret (Decision C);
			// the server resolves the jobId from the binding, NOT from the request body.
			const authSessionId = verifyCallerSession(req, deps, fail);
			if (!authSessionId) return true;
			if (deps.sandboxScope && !deps.sandboxScope.sessionIds.has(authSessionId)) {
				fail(403, "Forbidden: PR walkthrough YAML submit session is outside sandbox scope", { code: "SANDBOX_SESSION_OUT_OF_SCOPE" });
				return true;
			}
			const store = deps.packStore ?? getPackStore();
			const binding = await store.get<PrWalkthroughBinding>(PRW_PACK_ID, prwBindingKey(authSessionId));
			if (!binding || typeof binding !== "object") {
				fail(403, "Caller is not a bound PR-walkthrough reviewer", { code: "WALKTHROUGH_NOT_BOUND", retryable: false });
				return true;
			}
			// FINDING 1 — trusted-host gate (restores assertTrustedGithubTarget): an
			// untrusted-host PR can never have a walkthrough published. Applied BEFORE
			// validation/persistence so nothing is published for an untrusted host.
			if (!assertTrustedBindingTarget(binding, deps, fail)) return true;
			const already = await store.get(PRW_PACK_ID, prwSubmittedKey(binding.jobId));
			if (already || PRW_TERMINAL_STATUSES.has(binding.status ?? "")) {
				fail(409, "This PR walkthrough has already accepted a YAML submission.", { code: "WALKTHROUGH_ALREADY_READY", retryable: false });
				return true;
			}
			// Validate the YAML SHAPE only (full synthesis stays in the pack publish route).
			// On invalid, persist nothing and return a structured schema error.
			const validation = validatePrWalkthroughYaml(body.yaml, { target: binding.target });
			if (!validation.ok) {
				json({ ok: false, status: "validation_failed", retryable: true, validation: validation.summary });
				return true;
			}
			await store.put(PRW_PACK_ID, prwSubmittedKey(binding.jobId), {
				yaml: body.yaml,
				baseSha: binding.baseSha,
				headSha: binding.headSha,
				submittedAt: Date.now(),
			});
			await store.put(PRW_PACK_ID, prwBindingKey(authSessionId), { ...binding, status: "submitted" });
			// Stamp the GENERIC persisted terminal marker BEFORE dismiss, so a restart
			// between here and the dismiss still lets the generic boot-reap remove the
			// reviewer (Decision E / Findings 3–4).
			try { deps.sessionManager?.updateSessionMeta?.(authSessionId, { childTerminal: true, terminalAt: Date.now() }); }
			catch (err) { console.warn(`[pr-walkthrough] failed to stamp terminal marker for ${authSessionId}:`, err); }
			// Terminal-synchronous reap: server-dismiss the reviewer without waiting for a
			// panel poll (Decision E). Best-effort — the boot-reap is the backstop.
			if (deps.orchestrationCore && binding.parentSessionId) {
				try { await deps.orchestrationCore.dismiss(binding.parentSessionId, authSessionId); }
				catch (err) { console.warn(`[pr-walkthrough] failed to dismiss reviewer ${authSessionId}:`, err); }
			}
			json({ ok: true, status: "submitted", jobId: binding.jobId });
			return true;
		}

		// VIEWER-FEED + legacy /launch routes deleted. The reviewer is now minted via
		// `host.agents.spawn` from the pack `run` route (design Decision F Phase 3);
		// /resolve, /export/*, and the internal bundle/submit-yaml routes stay (the
		// agent toolchain + the standalone walkthrough resolver).
		if (url.pathname === "/api/pr-walkthrough/resolve" && req.method === "POST") {
			const body = await deps.readBody(req);
			if (!body || typeof body !== "object") {
				fail(400, "Invalid resolve request");
				return true;
			}
			const extraHosts = normalizeTrustedHosts(deps.preferencesStore?.get("githubTrustedHosts"));
			const result = sanitizeResolveResult(await resolveWalkthrough(body, deps, extraHosts), extraHosts);
			await storeWalkthrough(result);
			json(result);
			return true;
		}

		const previewMatch = url.pathname.match(/^\/api\/pr-walkthrough\/(.+)\/export\/preview$/);
		if (previewMatch && req.method === "POST") {
			const changesetId = decodeURIComponent(previewMatch[1]);
			const stored = await loadWalkthrough(changesetId);
			if (!stored) {
				fail(404, `Walkthrough not found: ${changesetId}`);
				return true;
			}
			const draft = await deps.readBody(req);
			if (!draft || typeof draft !== "object") {
				fail(400, "Invalid review draft");
				return true;
			}
			json(await buildExportPreview(changesetId, stored.payload, draft));
			return true;
		}

		const submitMatch = url.pathname.match(/^\/api\/pr-walkthrough\/(.+)\/export\/submit$/);
		if (submitMatch && req.method === "POST") {
			const changesetId = decodeURIComponent(submitMatch[1]);
			const stored = await loadWalkthrough(changesetId);
			if (!stored) {
				fail(404, `Walkthrough not found: ${changesetId}`);
				return true;
			}
			const body = await deps.readBody(req);
			if (!body || typeof body !== "object") {
				fail(400, "Invalid export submit request");
				return true;
			}
			if (body.confirm !== true) {
				fail(400, "Explicit confirmation is required before submitting a GitHub review", { code: "CONFIRMATION_REQUIRED" });
				return true;
			}
			const result = await submitExport(changesetId, stored.payload, body);
			json(result, result.ok ? 200 : typeof result.status === "number" ? result.status : 400);
			return true;
		}

		fail(405, "Unsupported PR walkthrough route");
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const typed = typedRouteError(err);
		const status = typed?.status ?? (/not found|unknown|invalid|missing|required/i.test(message) ? 400 : 500);
		fail(status, message, typed?.extra);
		return true;
	}
}

async function resolveWalkthrough(body: Record<string, unknown>, deps: PrWalkthroughRouteDeps, extraHosts: string[] = []): Promise<WalkthroughResolveResult> {
	if (body.fixture === true) return fixtureWalkthrough();

	const sessionId = stringValue(body.sessionId);
	const cwd = await resolveRequestCwd(body, deps, sessionId);
	const context: WalkthroughSynthesisContext = { sessionId, cwd };
	const baseSha = stringValue(body.baseSha);
	const headSha = stringValue(body.headSha);
	const prUrl = stringValue(body.prUrl);
	const prNumber = typeof body.prNumber === "number" || typeof body.prNumber === "string" ? body.prNumber : undefined;
	const prTitle = stringValue(body.prTitle) || stringValue(body.title);
	const wantsGithub = Boolean(prUrl || prNumber || body.provider === "github");

	if (wantsGithub && (!baseSha || !headSha)) {
		const delegated = await tryResolveGithubWithDelegation({ cwd, prUrl, prNumber, trustedHosts: extraHosts }, deps, context);
		if (delegated) return delegated;
		throw new Error("GitHub PR resolution is unavailable without local baseSha/headSha or the GitHub adapter");
	}

	if (wantsGithub && baseSha && headSha) {
		const local = await resolveLocalWithDelegation(cwd, baseSha, headSha, deps, context);
		const gh = parseGithubRef(prUrl, prNumber, cwd, extraHosts);
		const head = shortSha(local.changeset.headSha);
		const number = prNumber ?? gh?.number;
		const changesetId = gh ? changesetIdForGithub(gh.host, gh.owner, gh.repo, gh.number, head) : `github:unknown#${number ?? "unknown"}:${head}`;
		const title = prTitle
			? (number != null && !/^PR\s+#/i.test(prTitle) ? `PR #${number}: ${prTitle}` : prTitle)
			: gh ? `PR #${gh.number}: ${local.changeset.title ?? "Walkthrough"}` : local.changeset.title;
		return {
			...local,
			changesetId,
			changeset: {
				...local.changeset,
				provider: "github",
				prUrl: gh?.url,
				prNumber: number,
				prTitle,
				prBody: stringValue(body.prBody),
				externalUrl: gh?.url,
				title,
			},
			export: { provider: "github", available: false, previewOnly: true, reason: "GitHub submission requires adapter credentials; preview is available." },
		};
	}

	if (!baseSha || !headSha) throw new Error("baseSha and headSha are required for local walkthrough resolution");
	return resolveLocalWithDelegation(cwd, baseSha, headSha, deps, context);
}

async function resolveRequestCwd(body: Record<string, unknown>, deps: PrWalkthroughRouteDeps, sessionId: string | undefined): Promise<string> {
	if (typeof body.cwd === "string" && body.cwd.trim()) return body.cwd.trim();
	if (sessionId && deps.resolveSessionCwd) {
		const sessionCwd = await deps.resolveSessionCwd(sessionId);
		if (typeof sessionCwd === "string" && sessionCwd.trim()) return sessionCwd.trim();
	}
	return deps.defaultCwd;
}

async function resolveLocalWithDelegation(cwd: string, baseSha: string, headSha: string, deps: PrWalkthroughRouteDeps, context: WalkthroughSynthesisContext): Promise<WalkthroughResolveResult> {
	const delegated = await tryResolveLocalWithModules(cwd, baseSha, headSha, deps, context);
	if (delegated) return delegated;
	return resolveLocalFallback(cwd, baseSha, headSha);
}

async function tryResolveLocalWithModules(cwd: string, baseSha: string, headSha: string, deps: PrWalkthroughRouteDeps, context: WalkthroughSynthesisContext): Promise<WalkthroughResolveResult | undefined> {
	const gitModule = await optionalPrModule("git-changeset");
	const resolveLocalChangeset = gitModule?.resolveLocalChangeset;
	if (typeof resolveLocalChangeset !== "function") return undefined;
	const resolved = await resolveLocalChangeset({ cwd, baseSha, headSha });
	if (isResolveResult(resolved)) return resolved;

	const changeset = resolved?.changeset ?? resolved?.metadata ?? resolved;
	const files = Array.isArray(resolved?.files) ? resolved.files : [];
	const warnings = Array.isArray(resolved?.warnings) ? resolved.warnings : [];
	const changesetId = typeof resolved?.changesetId === "string" ? resolved.changesetId : changesetIdForLocal(changeset?.baseSha ?? baseSha, changeset?.headSha ?? headSha);
	let cards = Array.isArray(resolved?.cards) ? resolved.cards : undefined;
	cards ??= await synthesizeCardsForResolver(changeset, files, warnings, deps, { ...context, changeset });
	return {
		changesetId,
		changeset,
		cards,
		warnings,
		limits: resolved?.limits,
		export: resolved?.export ?? { available: false, reason: "Local changesets can be previewed but not submitted to GitHub." },
	};
}

async function tryResolveGithubWithDelegation(input: Record<string, unknown>, deps: PrWalkthroughRouteDeps, context: WalkthroughSynthesisContext): Promise<WalkthroughResolveResult | undefined> {
	const module = await optionalPrModule("github-adapter");
	const resolveGithubPr = module?.resolveGithubPr;
	if (typeof resolveGithubPr !== "function") return undefined;
	const resolved = await resolveGithubPr(input);
	return normalizeGithubResolvedWalkthrough(resolved, deps, context);
}

export async function normalizeGithubResolvedWalkthrough(resolved: any, deps?: Partial<PrWalkthroughRouteDeps>, context?: Partial<WalkthroughSynthesisContext>): Promise<WalkthroughResolveResult | undefined> {
	if (isResolveResult(resolved)) return resolved;
	if (!resolved?.changeset) return undefined;
	const warnings = Array.isArray(resolved.warnings) ? resolved.warnings : [];
	const files = Array.isArray(resolved.files) ? resolved.files : [];
	const routeDeps = deps ? { ...deps, defaultCwd: deps.defaultCwd ?? "", readBody: deps.readBody ?? (async () => ({})) } as PrWalkthroughRouteDeps : undefined;
	const cards = Array.isArray(resolved.cards)
		? resolved.cards
		: await synthesizeCardsForResolver(resolved.changeset, files, warnings, routeDeps, { cwd: context?.cwd ?? "", sessionId: context?.sessionId, changeset: resolved.changeset });
	return {
		changesetId: typeof resolved.changesetId === "string" ? resolved.changesetId : changesetIdForLocal(resolved.changeset.baseSha, resolved.changeset.headSha),
		changeset: resolved.changeset,
		cards,
		warnings,
		limits: resolved.limits,
		export: resolved.export,
	};
}

async function synthesizeCardsForResolver(
	changeset: WalkthroughChangeset,
	files: any[],
	warnings: WalkthroughWarning[],
	deps?: PrWalkthroughRouteDeps,
	context: WalkthroughSynthesisContext = { cwd: "" },
): Promise<WalkthroughCard[]> {
	const synthesisModule = await optionalPrModule("card-synthesis");
	const synthesize = synthesisModule?.synthesiseWalkthroughCards ?? synthesisModule?.synthesizeWalkthroughCards;
	if (typeof synthesize === "function") {
		const llm = await resolveConfiguredSynthesisAdapter(deps, { ...context, changeset });
		const cards = await synthesize(changeset, files, { warnings, ...(llm ? { allowLlm: true, llm } : {}) });
		if (Array.isArray(cards) && cards.length > 0) return cards;
	}
	return synthesizeFallbackCards(changeset, flattenDiffBlocks(files), warnings);
}

async function resolveConfiguredSynthesisAdapter(deps: PrWalkthroughRouteDeps | undefined, context: WalkthroughSynthesisContext): Promise<WalkthroughLlmAdapter | undefined> {
	if (synthesisAdapterForTesting) return synthesisAdapterForTesting;
	if (deps?.createSynthesisAdapter) {
		const adapter = await deps.createSynthesisAdapter(context);
		if (adapter) return adapter;
	}
	const envAdapter = await resolveEnvSynthesisAdapter();
	if (envAdapter) return envAdapter;
	if (deps) return createModelBackedSynthesisAdapter(deps, context);
	return undefined;
}

async function resolveEnvSynthesisAdapter(): Promise<WalkthroughLlmAdapter | undefined> {
	if (configuredSynthesisAdapter !== undefined) return configuredSynthesisAdapter ?? undefined;
	const modulePath = stringValue(process.env.BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER);
	if (!modulePath) {
		configuredSynthesisAdapter = null;
		return undefined;
	}
	const module = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
	const adapter = module.default ?? module.synthesiseWalkthroughCards ?? module.synthesizeWalkthroughCards ?? module.synthesise;
	configuredSynthesisAdapter = typeof adapter === "function" ? adapter : null;
	return configuredSynthesisAdapter ?? undefined;
}

export async function createModelBackedSynthesisAdapter(deps: PrWalkthroughRouteDeps, context: WalkthroughSynthesisContext): Promise<WalkthroughLlmAdapter | undefined> {
	const prefs = deps.preferencesStore;
	if (!prefs) return undefined;
	const modelPref = await resolveSynthesisModelPref(deps, context.sessionId);
	if (!modelPref) return undefined;
	const slash = modelPref.indexOf("/");
	if (slash <= 0 || slash >= modelPref.length - 1) return undefined;
	const provider = modelPref.slice(0, slash);
	const modelId = modelPref.slice(slash + 1);
	const models = await (deps.getAvailableModels ?? defaultGetAvailableModels)(prefs as any);
	const model = models.find(item => item.provider === provider && item.id === modelId);
	if (!model) return undefined;
	const complete = deps.completeModelText ?? defaultCompleteModelText;
	return async input => {
		const text = await complete(model, prefs as any, {
			systemPrompt: PR_WALKTHROUGH_SYNTHESIS_SYSTEM_PROMPT,
			userPrompt: buildSynthesisUserPrompt(input),
			maxTokens: 2400,
			thinkingLevel: "off",
			timeoutMs: 30_000,
		});
		return parseJsonFromModelText(text);
	};
}

const PR_WALKTHROUGH_SYNTHESIS_SYSTEM_PROMPT = `You synthesize concise PR walkthrough review cards from parsed diffs. Return only JSON with a top-level "cards" array. Each card must include phaseId (orientation, design, significant, other, or audit), title, summary, and diffBlockIds referencing only provided IDs. Each card may also include navLabel: a compact sidebar label of at most 3 words and 24 characters so the navigation rail never truncates; keep the full descriptive title in title. Omit navLabel to auto-derive it from the title. The orientation card is special: it should explain PR context for reviewers (why the PR was raised, context/background needed to understand it, testing strategy, and useful PR-description details) and may use an empty diffBlockIds array. Do not make orientation a summary of the walkthrough process. Suggested comments may include diffBlockId, lineId, and body. Do not invent file paths, block ids, or line ids.`;

async function resolveSynthesisModelPref(deps: PrWalkthroughRouteDeps, sessionId: string | undefined): Promise<string | undefined> {
	if (sessionId && deps.resolveSessionModel) {
		const sessionModel = await deps.resolveSessionModel(sessionId);
		const normalized = normalizeModelPref(sessionModel);
		if (normalized) return normalized;
	}
	const reviewModel = normalizeModelPref(deps.preferencesStore?.get("default.reviewModel"));
	if (reviewModel) return reviewModel;
	return normalizeModelPref(deps.preferencesStore?.get("default.sessionModel"));
}

function normalizeModelPref(value: unknown): string | undefined {
	if (typeof value === "string" && value.includes("/")) return value.trim();
	if (!value || typeof value !== "object") return undefined;
	const record = value as { provider?: unknown; id?: unknown; modelId?: unknown };
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const id = typeof record.id === "string" ? record.id.trim() : typeof record.modelId === "string" ? record.modelId.trim() : "";
	return provider && id ? `${provider}/${id}` : undefined;
}

function buildSynthesisUserPrompt(input: Record<string, unknown>): string {
	return JSON.stringify(input, null, 2);
}

function parseJsonFromModelText(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		return text;
	}
}

function flattenDiffBlocks(files: any[]): DiffBlock[] {
	const blocks: DiffBlock[] = [];
	for (const file of files) {
		if (Array.isArray(file?.diffBlocks)) blocks.push(...file.diffBlocks.filter(isDiffBlock));
		else if (isDiffBlock(file)) blocks.push(file);
	}
	return blocks;
}

function isDiffBlock(value: any): value is DiffBlock {
	return (
		typeof value?.id === "string" &&
		typeof value?.filePath === "string" &&
		Array.isArray(value?.hunks) &&
		value.hunks.every((hunk: any) => hunk !== null && typeof hunk === "object" && typeof hunk.header === "string")
	);
}

async function resolveLocalFallback(cwd: string, baseSha: string, headSha: string): Promise<WalkthroughResolveResult> {
	const base = await git(cwd, ["rev-parse", "--verify", `${baseSha}^{commit}`]).catch(() => {
		throw new Error(`Invalid baseSha: ${baseSha}`);
	});
	const head = await git(cwd, ["rev-parse", "--verify", `${headSha}^{commit}`]).catch(() => {
		throw new Error(`Invalid headSha: ${headSha}`);
	});
	const fullBase = base.trim();
	const fullHead = head.trim();
	const diff = await git(cwd, ["diff", "--no-ext-diff", "--find-renames", "--find-copies", "--binary", "--unified=80", fullBase, fullHead]);
	const nameStatus = await git(cwd, ["diff", "--name-status", "-M", "-C", fullBase, fullHead]);
	const shortstat = await git(cwd, ["diff", "--shortstat", fullBase, fullHead]).catch(() => "");
	const warnings: WalkthroughWarning[] = [];
	const blocks = parseUnifiedDiff(diff, warnings);
	applyNameStatus(blocks, nameStatus);
	const stats = parseShortstat(shortstat, blocks.length);
	const changeset: WalkthroughChangeset = {
		baseSha: fullBase,
		headSha: fullHead,
		provider: "local",
		title: `${shortSha(fullBase)}..${shortSha(fullHead)}`,
		filesChanged: stats.filesChanged,
		additions: stats.additions,
		deletions: stats.deletions,
	};
	const cards = synthesizeFallbackCards(changeset, blocks, warnings);
	return {
		changesetId: changesetIdForLocal(fullBase, fullHead),
		changeset,
		cards,
		warnings,
		export: { available: false, reason: "Local changesets can be previewed but not submitted to GitHub." },
	};
}

function parseUnifiedDiff(diff: string, warnings: WalkthroughWarning[]): DiffBlock[] {
	const lines = diff.split(/\r?\n/);
	const blocks: DiffBlock[] = [];
	let block: DiffBlock | undefined;
	let hunk: DiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;
	let hunkIndex = -1;

	for (const raw of lines) {
		if (raw.startsWith("diff --git ")) {
			const match = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
			const filePath = match?.[2] ?? raw.replace(/^diff --git\s+/, "");
			block = { id: `block-${blocks.length + 1}-${slug(filePath)}`, filePath, oldPath: match?.[1], status: "modified", hunks: [] };
			blocks.push(block);
			hunk = undefined;
			hunkIndex = -1;
			continue;
		}
		if (!block) continue;
		if (raw.startsWith("new file mode")) block.status = "added";
		else if (raw.startsWith("deleted file mode")) block.status = "deleted";
		else if (raw.startsWith("rename from ")) { block.oldPath = raw.slice("rename from ".length); block.status = "renamed"; }
		else if (raw.startsWith("rename to ")) { block.filePath = raw.slice("rename to ".length); block.id = block.id.replace(/-[^-]*$/, `-${slug(block.filePath)}`); }
		else if (raw.startsWith("copy from ")) { block.oldPath = raw.slice("copy from ".length); block.status = "copied"; }
		else if (raw.startsWith("Binary files ")) {
			block.status = "binary";
			warnings.push({ code: "binary-file", severity: "warning", message: `Binary file cannot be rendered: ${block.filePath}`, filePath: block.filePath });
		}
		else if (raw.startsWith("--- ")) {
			const p = raw.slice(4).trim();
			if (p.startsWith("a/")) block.oldPath = p.slice(2);
		}
		else if (raw.startsWith("+++ ")) {
			const p = raw.slice(4).trim();
			if (p.startsWith("b/")) block.filePath = p.slice(2);
		}
		else if (raw.startsWith("@@ ")) {
			const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			oldLine = match ? Number(match[1]) : 0;
			newLine = match ? Number(match[2]) : 0;
			hunkIndex += 1;
			hunk = { id: `${block.id}-h${hunkIndex + 1}`, header: raw, lines: [] };
			block.hunks.push(hunk);
		}
		else if (hunk && (raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-"))) {
			const lineIndex = hunk.lines.length;
			const prefix = raw[0];
			const text = raw.slice(1);
			if (prefix === " ") {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "context", oldLine, newLine, kind: "context", text });
				oldLine += 1;
				newLine += 1;
			} else if (prefix === "+") {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "new", newLine, kind: "add", text });
				newLine += 1;
			} else {
				hunk.lines.push({ id: `${block.id}:h${hunkIndex}:l${lineIndex}`, side: "old", oldLine, kind: "del", text });
				oldLine += 1;
			}
		}
	}
	return blocks;
}

function applyNameStatus(blocks: DiffBlock[], nameStatus: string): void {
	for (const line of nameStatus.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const code = parts[0];
		const status = code.startsWith("R") ? "renamed"
			: code.startsWith("C") ? "copied"
			: code === "A" ? "added"
			: code === "D" ? "deleted"
			: code === "M" ? "modified"
			: undefined;
		const filePath = parts.at(-1);
		const block = blocks.find(item => item.filePath === filePath || item.oldPath === filePath);
		if (block && status) {
			block.status = block.status === "binary" ? "binary" : status;
			if ((status === "renamed" || status === "copied") && parts[1]) block.oldPath = parts[1];
		}
	}
}

function synthesizeFallbackCards(changeset: WalkthroughChangeset, files: DiffBlock[], warnings: WalkthroughWarning[]): WalkthroughCard[] {
	const prContext = stringValue(changeset.prBody);
	const why = prContext ? prContext.replace(/\s+/g, " ").slice(0, 220) : changeset.prTitle ?? changeset.title ?? "No PR description was available.";
	const context = changeset.prTitle ?? changeset.title ?? "No additional PR context was provided.";
	const cards: WalkthroughCard[] = [{
		id: "orientation-summary",
		phaseId: "orientation",
		title: "PR context",
		navLabel: "Orientation",
		summary: `Why this PR was raised: ${why}`,
		rationale: `Context to understand the PR: ${context}`,
		diffBlocks: [],
		checklist: ["Testing strategy: No testing strategy was specified in the PR description.", ...warnings.slice(0, 2).map(warning => warning.filePath ? `${warning.filePath}: ${warning.message}` : warning.message)],
		sections: [
			{ id: "at-a-glance", navLabel: "At a glance", heading: "At a glance", body: `Why this PR was raised: ${why}`, showStats: true },
			{ id: "why-it-exists", navLabel: "Why it exists", eyebrow: "The problem", heading: "Why it exists", body: why },
			{ id: "what-it-changes", navLabel: "What it changes", eyebrow: "The change", heading: "What it changes", body: context },
			{ id: "where-to-look", navLabel: "Where to look", heading: "Where to look", body: context, showOriginalDescription: true },
		],
	}];
	if (files.length > 0) {
		const reviewBlocks = files.filter(file => file.status !== "binary");
		cards.push({
			id: "significant-files",
			phaseId: "significant",
			title: "Changed files",
			navLabel: deriveNavLabel("Changed files"),
			summary: `Review ${reviewBlocks.length || files.length} diff-backed file${(reviewBlocks.length || files.length) === 1 ? "" : "s"}.`,
			diffBlocks: reviewBlocks.length ? reviewBlocks : files,
		});
		cards.push({
			id: "audit-coverage",
			phaseId: "audit",
			title: "Audit remaining coverage",
			navLabel: deriveNavLabel("Audit remaining coverage"),
			summary: "Final pass over the resolved diff and any unreviewable files.",
			diffBlocks: files,
			cardSuggestions: warnings.map(warning => warning.message),
		});
	}
	return cards;
}

async function buildExportPreview(changesetId: string, payload: WalkthroughResolveResult, draft: any): Promise<Record<string, unknown>> {
	const delegated = await tryBuildExportPreview(changesetId, payload, draft);
	if (delegated) return delegated;

	const comments = Array.isArray(draft.comments) ? draft.comments : [];
	const rows = comments.map((comment: any) => mapComment(comment, payload.cards));
	const cardComments = comments.filter((comment: any) => !comment.diffBlockId && !comment.lineId);
	const body = [
		`Review draft for ${payload.changeset.title ?? changesetId}`,
		...cardComments.map((comment: any) => {
			const card = payload.cards.find(item => item.id === comment.cardId);
			return `- ${card?.title ?? comment.cardId}: ${comment.body ?? ""}`;
		}),
	].join("\n");
	return {
		changesetId,
		provider: payload.changeset.provider,
		available: payload.export?.available ?? false,
		canSubmit: Boolean(payload.export?.available && payload.export.provider === "github" && rows.some((row: any) => row.valid)),
		body,
		rows,
		warnings: rows.filter((row: any) => !row.valid).map((row: any) => ({ code: "unmappable-comment", severity: "warning", message: row.reason, commentId: row.commentId })),
	};
}

async function tryBuildExportPreview(changesetId: string, payload: WalkthroughResolveResult, draft: any): Promise<Record<string, unknown> | undefined> {
	const module = await optionalPrModule("export-mapper");
	const buildGithubReviewPreview = module?.buildGithubReviewPreview;
	if (typeof buildGithubReviewPreview !== "function") return undefined;
	return buildGithubReviewPreview(draft, payload.cards, payload.changeset, { changesetId, export: payload.export });
}

function mapComment(comment: any, cards: WalkthroughCard[]): Record<string, unknown> {
	if (!comment?.diffBlockId || !comment?.lineId) {
		return { commentId: comment?.id, body: comment?.body ?? "", valid: false, reason: "Card-level comments are included in the review body." };
	}
	const card = cards.find(item => item.id === comment.cardId);
	const block = card?.diffBlocks.find(item => item.id === comment.diffBlockId);
	const line = block?.hunks.flatMap(hunk => hunk.lines).find(item => item.id === comment.lineId);
	if (!card || !block || !line) {
		return { commentId: comment.id, body: comment.body ?? "", valid: false, reason: "Comment anchor no longer maps to a resolved diff line." };
	}
	const lineNumber = line.newLine ?? line.oldLine;
	if (!lineNumber) {
		return { commentId: comment.id, path: block.filePath, body: comment.body ?? "", valid: false, reason: "Diff line has no GitHub-reviewable line number." };
	}
	return {
		commentId: comment.id,
		path: block.filePath,
		side: line.side === "old" ? "LEFT" : "RIGHT",
		line: lineNumber,
		body: comment.body ?? "",
		valid: true,
	};
}

async function submitExport(changesetId: string, payload: WalkthroughResolveResult, body: any): Promise<Record<string, unknown>> {
	void changesetId;
	if (payload.export?.provider !== "github" || payload.export.available !== true) {
		return { ok: false, error: "GitHub review submission is unavailable for this walkthrough", code: "EXPORT_UNAVAILABLE" };
	}
	const module = await optionalPrModule("export-mapper");
	const buildGithubReviewPreview = module?.buildGithubReviewPreview;
	const submitGithubReview = module?.submitGithubReview;
	if (typeof buildGithubReviewPreview === "function" && typeof submitGithubReview === "function") {
		const preview = buildGithubReviewPreview(body.draft, payload.cards, payload.changeset);
		return submitGithubReview(preview, { confirm: true, event: body.event });
	}
	return { ok: false, error: "GitHub review submission adapter is unavailable", code: "EXPORT_ADAPTER_UNAVAILABLE" };
}

export const submitExportForTesting = submitExport;

function sanitizeResolveResult(payload: WalkthroughResolveResult, extraHosts: string[] = []): WalkthroughResolveResult {
	return {
		...payload,
		changeset: sanitizeChangesetUrls(payload.changeset, extraHosts),
		cards: payload.cards.map(card => ({
			...card,
			diffBlocks: card.diffBlocks.map(block => sanitizeDiffBlockUrls(block, extraHosts)),
		})),
		export: payload.export ? sanitizeExportUrls(payload.export, extraHosts) : payload.export,
	};
}

function sanitizeChangesetUrls(changeset: WalkthroughChangeset, extraHosts: string[] = []): WalkthroughChangeset {
	const externalUrl = safeExternalUrl(changeset.externalUrl, extraHosts);
	const prUrl = safeExternalUrl(changeset.prUrl, extraHosts);
	return {
		...changeset,
		...(externalUrl ? { externalUrl } : { externalUrl: undefined }),
		...(prUrl ? { prUrl } : { prUrl: undefined }),
	};
}

function sanitizeDiffBlockUrls(block: DiffBlock, extraHosts: string[] = []): DiffBlock {
	return {
		...block,
		externalUrl: safeExternalUrl(block.externalUrl, extraHosts),
		blobUrl: safeExternalUrl(block.blobUrl, extraHosts),
		rawUrl: safeExternalUrl(block.rawUrl, extraHosts),
		contentsUrl: safeExternalUrl(block.contentsUrl, extraHosts),
	};
}

function sanitizeExportUrls(exportCapability: WalkthroughExportCapability, extraHosts: string[] = []): WalkthroughExportCapability {
	const sanitized: WalkthroughExportCapability = { ...exportCapability };
	for (const key of ["url", "previewUrl", "submitUrl"] as const) {
		if (typeof sanitized[key] === "string") sanitized[key] = safeExternalUrl(sanitized[key], extraHosts);
	}
	return sanitized;
}

async function storeWalkthrough(payload: WalkthroughResolveResult): Promise<void> {
	const module = await optionalPrModule("walkthrough-store");
	const store = module?.storeWalkthrough ?? module?.saveWalkthrough;
	if (typeof store === "function") {
		await store(payload);
		return;
	}
	const stored: StoredWalkthrough = { schemaVersion: STORE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), payload };
	await fs.mkdir(storeDir(), { recursive: true });
	await fs.writeFile(storePath(payload.changesetId), JSON.stringify(stored, null, 2), "utf-8");
}

async function loadWalkthrough(changesetId: string): Promise<StoredWalkthrough | undefined> {
	const module = await optionalPrModule("walkthrough-store");
	const load = module?.loadWalkthrough ?? module?.getWalkthrough;
	if (typeof load === "function") {
		const loaded = await load(changesetId);
		if (loaded?.payload) return loaded;
		if (loaded?.changesetId) return { schemaVersion: STORE_SCHEMA_VERSION, updatedAt: loaded.updatedAt ?? new Date().toISOString(), payload: loaded };
	}
	try {
		const raw = await fs.readFile(storePath(changesetId), "utf-8");
		const parsed = JSON.parse(raw) as StoredWalkthrough;
		if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) return undefined;
		return parsed;
	} catch (err: any) {
		if (err?.code === "ENOENT") return undefined;
		throw err;
	}
}

function storeDir(): string {
	return path.join(bobbitStateDir(), "pr-walkthrough");
}

function storePath(changesetId: string): string {
	return path.join(storeDir(), `${Buffer.from(changesetId).toString("base64url")}.json`);
}

function typedRouteError(err: unknown): { status: number; extra: Record<string, unknown> } | undefined {
	if (!err || typeof err !== "object") return undefined;
	const candidate = err as { status?: unknown; code?: unknown; warnings?: unknown; extra?: unknown };
	const status = typeof candidate.status === "number" && candidate.status >= 400 && candidate.status < 600 ? candidate.status : undefined;
	const extra = candidate.extra && typeof candidate.extra === "object" && !Array.isArray(candidate.extra) ? candidate.extra as Record<string, unknown> : undefined;
	if (!status && typeof candidate.code !== "string" && !Array.isArray(candidate.warnings) && !extra) return undefined;
	return {
		status: status ?? 500,
		extra: {
			...(extra ?? {}),
			...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
			...(Array.isArray(candidate.warnings) ? { warnings: candidate.warnings } : {}),
		},
	};
}

async function optionalPrModule(name: string): Promise<any | undefined> {
	try {
		return await import(`./${name}.js`);
	} catch (err: any) {
		if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module|module not found/i.test(String(err?.message))) return undefined;
		throw err;
	}
}

function isResolveResult(value: any): value is WalkthroughResolveResult {
	return typeof value?.changesetId === "string" && value?.changeset && Array.isArray(value?.cards) && Array.isArray(value?.warnings);
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
	return stdout;
}

function parseShortstat(shortstat: string, fallbackFiles: number): { filesChanged: number; additions: number; deletions: number } {
	return {
		filesChanged: Number(shortstat.match(/(\d+) files? changed/)?.[1] ?? fallbackFiles),
		additions: Number(shortstat.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
		deletions: Number(shortstat.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
	};
}

function changesetIdForLocal(baseSha: string, headSha: string): string {
	return `${shortSha(baseSha)}..${shortSha(headSha)}`;
}

// github.com / www.github.com keep the legacy un-prefixed id; other hosts are
// host-qualified so enterprise PRs sharing owner/repo/number do not collide.
function changesetIdForGithub(host: string | undefined, owner: string, repo: string, number: string | number, headSha?: string): string {
	const normalized = (host || "github.com").replace(/\.$/, "").toLowerCase();
	const prefix = normalized === "github.com" || normalized === "www.github.com" ? "" : `${normalized}/`;
	return `github:${prefix}${owner}/${repo}#${number}:${headSha || "unknown"}`;
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function slug(value: string): string {
	const clean = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48);
	return clean || "file";
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
	const value = req.headers[name.toLowerCase()];
	if (Array.isArray(value)) return stringValue(value[0]);
	return stringValue(value);
}

function bundleReadRequestFrom(url: URL, body: unknown): ReadPrWalkthroughBundleRequest {
	const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
	return {
		sessionId: stringValue(record.sessionId) ?? stringValue(url.searchParams.get("sessionId")) ?? "",
		jobId: stringValue(record.jobId) ?? stringValue(url.searchParams.get("jobId")) ?? "",
		mode: (stringValue(record.mode) ?? stringValue(url.searchParams.get("mode"))) as ReadPrWalkthroughBundleRequest["mode"],
		path: stringValue(record.path) ?? stringValue(record.file) ?? stringValue(url.searchParams.get("path")) ?? stringValue(url.searchParams.get("file")),
		index: numberValue(record.index) ?? numberValue(url.searchParams.get("index")),
		offset: numberValue(record.offset) ?? numberValue(url.searchParams.get("offset")),
		limit: numberValue(record.limit) ?? numberValue(url.searchParams.get("limit")),
		hunkOffset: numberValue(record.hunkOffset) ?? numberValue(url.searchParams.get("hunkOffset")),
		hunkLimit: numberValue(record.hunkLimit) ?? numberValue(url.searchParams.get("hunkLimit")),
	};
}

// ── host.agents reviewer migration helpers (design Decisions C/D/E) ──────────

/** The pack-store binding the `run` route writes under `binding/<childSessionId>`. */
type PrWalkthroughBinding = {
	jobId: string;
	changesetId?: string;
	baseSha?: string;
	headSha?: string;
	parentSessionId?: string;
	canonicalKey?: string;
	target: PrWalkthroughTarget;
	status?: string;
	kickedOff?: boolean;
};

/**
 * Resolve the AUTHENTIC caller session id from the REQUIRED `X-Bobbit-Session-Secret`
 * header (Decision C). Routing/correctness, not a security boundary (single-user trust
 * domain) — but REQUIRED for the binding-routed submit-yaml/bundle paths: every
 * reviewer child always carries BOBBIT_SESSION_SECRET, so a missing/unresolved secret
 * hard-fails 403 (it does NOT degrade to a weaker check). The `sandboxScope.sessionIds`
 * check at each call site remains an ADDITIONAL floor. Writes the 403 and returns
 * undefined on failure.
 */
function verifyCallerSession(
	req: http.IncomingMessage,
	deps: PrWalkthroughRouteDeps,
	fail: (status: number, message: string, extra?: Record<string, unknown>) => void,
): string | undefined {
	const secret = headerValue(req, "x-bobbit-session-secret");
	const sessionId = deps.sessionSecretStore?.resolveSessionIdBySecret(secret);
	if (!sessionId) {
		fail(403, "Forbidden: a valid X-Bobbit-Session-Secret is required for PR walkthrough tool routes", { code: "WALKTHROUGH_SESSION_SECRET_REQUIRED", retryable: false });
		return undefined;
	}
	return sessionId;
}

/**
 * FINDING 1 — trusted-host gate for a binding-routed reviewer. Restores the
 * legacy launcher's `assertTrustedGithubTarget` chokepoint (which rejected
 * untrusted GitHub enterprise hosts BEFORE any diff was resolved). The pack
 * `run` route runs in the CONFINED extension-host worker and CANNOT read gateway
 * preferences (`githubTrustedHosts`), so this enforcement must live SERVER-SIDE,
 * at the two binding-routed routes that DO have `deps.preferencesStore`. It is
 * applied to ALL github targets — INCLUDING the with-SHA local-recompute path in
 * `resolveDiffForBindingTarget`, which otherwise bypasses the github-adapter's
 * own trust check (the gap this finding closes). A reviewer child may already
 * have been spawned for an untrusted host (the worker can't pre-check prefs);
 * that is HARMLESS — bundle + submit both 403 here, resolving/publishing NOTHING,
 * and the child is reaped on cleanup. Returns false (and writes the 403) when the
 * target's host is not trusted. `github.com`/`www.github.com` are the
 * default-trusted baseline (via `isTrustedExternalHost`); enterprise hosts come
 * only from the `githubTrustedHosts` preference.
 */
function assertTrustedBindingTarget(
	binding: PrWalkthroughBinding,
	deps: PrWalkthroughRouteDeps,
	fail: (status: number, message: string, extra?: Record<string, unknown>) => void,
): boolean {
	// Only github targets reach an external host; local targets recompute from the
	// session worktree and have no host to trust.
	if (binding.target?.provider !== "github") return true;
	const host = bindingTargetHost(binding.target);
	const trustedHosts = normalizeTrustedHosts(deps.preferencesStore?.get("githubTrustedHosts"));
	if (host && isTrustedExternalHost(host, trustedHosts)) return true;
	fail(403, `Untrusted GitHub PR host: ${host ?? "unknown"}`, { code: "untrusted_github_host", host, retryable: false });
	return false;
}

/**
 * Derive the GitHub host from a binding target: prefer the canonical `host` field
 * (the pack `run` route's `canonicalizeTarget` sets it on every github target);
 * fall back to parsing `prUrl` when an older persisted binding lacks it.
 */
function bindingTargetHost(target: PrWalkthroughTarget): string | undefined {
	if (typeof target.host === "string" && target.host.trim()) {
		return target.host.trim().replace(/\.$/, "").toLowerCase();
	}
	if (typeof target.prUrl === "string" && target.prUrl.trim()) {
		try {
			return new URL(target.prUrl.trim()).hostname.replace(/\.$/, "").toLowerCase();
		} catch { return undefined; }
	}
	return undefined;
}

/**
 * Lazily resolve the analysis bundle for a reviewer binding from its TARGET via the
 * EXISTING server pipeline (github-adapter for GitHub PRs, git-changeset for local),
 * cache it in WalkthroughAnalysisBundleStore keyed by jobId, then serve the requested
 * read mode — byte-identical to what read_pr_walkthrough_bundle returned under the
 * legacy launcher. Standalone so it survives the later deletion of
 * walkthrough-agent-manager (design §6 / Decision D). The git cwd is the SESSION
 * worktree (server-derived), never caller-supplied; trusted-host/credential logic
 * stays server-side here (why bundle resolution cannot move into the confined worker).
 */
async function resolveAndReadBindingBundle(
	deps: PrWalkthroughRouteDeps,
	binding: PrWalkthroughBinding,
	sessionId: string,
	readReq: Omit<ReadPrWalkthroughBundleRequest, "sessionId" | "jobId">,
): Promise<Record<string, unknown>> {
	const stateDir = deps.stateDir ?? bobbitStateDir();
	const bundleStore = new WalkthroughAnalysisBundleStore(stateDir);
	const jobLike = {
		jobId: binding.jobId,
		childSessionId: sessionId,
		changesetId: binding.changesetId ?? binding.jobId,
		target: binding.target,
		title: titleForWalkthroughTarget(binding.target),
		cwd: "",
	} as unknown as PrWalkthroughJobRecord;
	// Resolve + cache lazily on first read; subsequent reads hit the cached bundle.
	if (!bundleStore.load(binding.jobId)) {
		const cwd = await resolveBindingCwd(deps, sessionId);
		jobLike.cwd = cwd;
		const parsedDiff = await resolveDiffForBindingTarget(binding.target, cwd, deps);
		const bundle = createAnalysisBundleFromParsedDiff(jobLike, parsedDiff);
		bundleStore.save(binding.jobId, bundle);
	}
	return bundleStore.read(jobLike, readReq);
}

async function resolveBindingCwd(deps: PrWalkthroughRouteDeps, sessionId: string): Promise<string> {
	if (deps.resolveSessionCwd) {
		const resolved = await deps.resolveSessionCwd(sessionId);
		if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
	}
	return deps.defaultCwd;
}

function titleForWalkthroughTarget(target: PrWalkthroughTarget): string {
	return target.provider === "github" && target.number !== undefined ? `PR #${target.number} Walkthrough` : "Changeset Walkthrough";
}

/**
 * Resolve the parsed diff for a binding target via the EXISTING server pipeline
 * (mirrors WalkthroughAgentManager.resolveLaunchDiffForBundle so the bundle is
 * byte-stable). GitHub targets with launch-time SHAs recompute locally and wrap the
 * GitHub metadata; GitHub targets without SHAs go through resolveGithubPr; local
 * targets recompute via resolveLocalChangeset.
 */
async function resolveDiffForBindingTarget(
	target: PrWalkthroughTarget,
	cwd: string,
	deps: PrWalkthroughRouteDeps,
): Promise<WalkthroughParsedDiffForYamlMapping> {
	const trustedHosts = normalizeTrustedHosts(deps.preferencesStore?.get("githubTrustedHosts"));
	if (target.provider === "local") {
		if (!target.baseSha || !target.headSha) throw new Error("Local PR walkthrough bundle requires baseSha and headSha.");
		const resolved = await resolveLocalChangeset({ cwd, baseSha: target.baseSha, headSha: target.headSha });
		return {
			changeset: resolved.changeset,
			files: resolved.files,
			warnings: resolved.warnings,
			limits: resolved.limits as WalkthroughParsedDiffForYamlMapping["limits"],
			export: { provider: "local", available: false, reason: "Local changesets can be previewed but not submitted to GitHub." },
		};
	}
	if (target.baseSha && target.headSha) {
		const resolved = await resolveLocalChangeset({ cwd, baseSha: target.baseSha, headSha: target.headSha });
		return {
			changeset: {
				...resolved.changeset,
				provider: "github",
				externalUrl: target.prUrl,
				prUrl: target.prUrl,
				prNumber: target.number,
				prBody: "",
			},
			files: resolved.files,
			warnings: resolved.warnings,
			limits: resolved.limits as WalkthroughParsedDiffForYamlMapping["limits"],
			export: { provider: "github", available: false, previewOnly: true, reason: "GitHub submission requires launch-time GitHub metadata; preview is available." },
		};
	}
	if (typeof deps.preflightGithubLaunch === "function") {
		await deps.preflightGithubLaunch({ jobId: "", target } as unknown as PrWalkthroughJobRecord);
	}
	const resolved = await resolveGithubPr({ cwd, prUrl: target.prUrl, prNumber: target.number, trustedHosts });
	return {
		changeset: resolved.changeset as WalkthroughParsedDiffForYamlMapping["changeset"],
		files: resolved.files as unknown as WalkthroughParsedDiffForYamlMapping["files"],
		warnings: resolved.warnings,
		export: resolved.export as unknown as WalkthroughParsedDiffForYamlMapping["export"],
	};
}

function parseGithubRef(prUrl: string | undefined, prNumber: string | number | undefined, cwd: string, extraHosts: string[] = []): { owner: string; repo: string; number: string | number; url: string; host: string } | undefined {
	if (prUrl) {
		let parsed: URL;
		try {
			parsed = new URL(prUrl);
		} catch {
			return undefined;
		}
		// Accept any host that safeExternalUrl already approved (DEFAULT baseline +
		// managed enterprise hosts). Previously this hardcoded github.com, discarding
		// owner/repo/number/url for trusted enterprise hosts (github:unknown metadata).
		const safeUrl = safeExternalUrl(prUrl, extraHosts);
		const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i.exec(parsed.pathname);
		if (safeUrl && match) {
			const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
			return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]).replace(/\.git$/i, ""), number: prNumber ?? match[3], url: safeUrl, host };
		}
	}
	void cwd;
	return undefined;
}

export const resolveWalkthroughForTesting = resolveWalkthrough;
export const parseGithubRefForTesting = parseGithubRef;

function fixtureWalkthrough(): WalkthroughResolveResult {
	const changeset: WalkthroughChangeset = {
		baseSha: "fixture-base",
		headSha: "fixture-head",
		provider: "fixture",
		title: "Fixture PR walkthrough",
		filesChanged: 1,
		additions: 1,
		deletions: 0,
	};
	const block: DiffBlock = {
		id: "fixture-block",
		filePath: "README.md",
		hunks: [{ id: "fixture-block-h1", header: "@@ -0,0 +1 @@", lines: [{ id: "fixture-block:h0:l0", side: "new", newLine: 1, kind: "add", text: "Fixture walkthrough" }] }],
	};
	return {
		changesetId: "fixture-base..fixture-head",
		changeset,
		cards: [{ id: "orientation-summary", phaseId: "orientation", title: "Fixture walkthrough", summary: "Fixture-backed walkthrough for tests and development.", diffBlocks: [block] }],
		warnings: [],
		export: { available: false, reason: "Fixture walkthroughs cannot be submitted." },
	};
}

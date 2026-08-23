import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	readProcessMetrics,
	spawnGateway,
	stopGateway,
	waitForGatewayReady,
} from "./runtime.mjs";

export const GATEWAY_STARTUP_CASES = Object.freeze([
	Object.freeze({ name: "0-sessions", sessionCount: 0, liveCount: 0 }),
	Object.freeze({ name: "100-sessions", sessionCount: 100, liveCount: 3 }),
	Object.freeze({ name: "1000-sessions", sessionCount: 1_000, liveCount: 3 }),
]);

export const GATEWAY_STARTUP_FIXTURE_VERSION = 2;
export const GATEWAY_STARTUP_PROJECT_ID = "headquarters";
export const GATEWAY_STARTUP_TOKEN = "b0bb17".repeat(10) + "b0bb";
export const GATEWAY_STARTUP_SEARCH_SENTINEL = "gateway-startup-search-sentinel";

const FIXTURE_EPOCH_MS = 1_700_000_000_000;
const READY_TIMEOUT_MS = 120_000;
const URL_TIMEOUT_MS = 30_000;
const VALIDATION_TIMEOUT_MS = 30_000;
const REACHABLE_ARCHIVED_COUNT = 8;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function assertion(condition, message) {
	if (!condition) throw new Error(`Gateway-startup correctness: ${message}`);
}

function sorted(values) {
	return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function sameStrings(actual, expected) {
	return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function boundedErrorMessage(error, maximum = 1_000) {
	const message = String(error?.message ?? error ?? "unknown cleanup failure");
	return message.length <= maximum ? message : `${message.slice(0, maximum - 14)}…[truncated]`;
}

function boundedIdArray(values, maximumItems = 16, maximumIdLength = 160) {
	const bounded = values.slice(0, maximumItems).map(value => boundedErrorMessage(value, maximumIdLength));
	if (values.length > maximumItems) bounded.push(`…[${values.length - maximumItems} omitted]`);
	return JSON.stringify(bounded);
}

function normalizeSemanticSession(session) {
	return {
		id: session?.id ?? null,
		title: session?.title ?? null,
		archived: session?.archived === true || session?.status === "archived",
		delegateOf: session?.delegateOf ?? null,
		parentSessionId: session?.parentSessionId ?? null,
		teamLeadSessionId: session?.teamLeadSessionId ?? null,
		teamGoalId: session?.teamGoalId ?? null,
		goalId: session?.goalId ?? null,
	};
}

function semanticProjection(manifest, sessions) {
	return {
		fixtureVersion: manifest.fixtureVersion,
		caseName: manifest.caseName,
		projectId: manifest.projectId,
		goalId: manifest.goalId,
		liveIds: [...manifest.liveIds],
		archivedIds: [...manifest.archivedIds],
		reachableArchivedIds: [...manifest.reachableArchivedIds],
		controls: [...manifest.controls],
		sessions,
	};
}

/** Project production API rows into the fixture's stable, non-volatile semantic order. */
export function projectObservedGatewayStartupSemantics(manifest, observedSessions) {
	if (!manifest || !Array.isArray(manifest.sessions) || !Array.isArray(observedSessions)) {
		throw new TypeError("Gateway-startup semantic projection requires a manifest and observed sessions");
	}
	const observedById = new Map();
	for (const session of observedSessions) {
		assertion(typeof session?.id === "string" && session.id.length > 0, "an observed session omitted its ID");
		assertion(!observedById.has(session.id), `production returned duplicate session ${session.id}`);
		observedById.set(session.id, session);
	}
	assertion(observedById.size === manifest.sessions.length, `semantic projection expected ${manifest.sessions.length} sessions, received ${observedById.size}`);
	const sessions = manifest.sessions.map(expected => {
		const observed = observedById.get(expected.id);
		assertion(observed, `semantic projection could not find ${expected.id}`);
		return normalizeSemanticSession(observed);
	});
	return semanticProjection(manifest, sessions);
}

/** Validate and hash only the stable session semantics observed through production APIs. */
export function validateGatewayStartupSemanticProjection(manifest, observedSessions) {
	const expectedProjection = semanticProjection(manifest, manifest.sessions.map(normalizeSemanticSession));
	const expectedSha256 = sha256(JSON.stringify(expectedProjection));
	assertion(expectedSha256 === manifest.semanticSha256, "fixture manifest semantic hash did not match its projection");
	const observedProjection = projectObservedGatewayStartupSemantics(manifest, observedSessions);
	const observedSha256 = sha256(JSON.stringify(observedProjection));
	assertion(JSON.stringify(observedProjection) === JSON.stringify(expectedProjection), "observed session relationship semantics changed");
	assertion(observedSha256 === expectedSha256, "observed semantic hash did not match the fixture");
	return { projection: observedProjection, semanticSha256: observedSha256 };
}

function caseDefinition(caseName) {
	const definition = GATEWAY_STARTUP_CASES.find(candidate => candidate.name === caseName);
	if (!definition) throw new Error(`Unknown gateway-startup case: ${caseName}`);
	return definition;
}

function liveId(caseName, index) {
	return `benchmark-${caseName}-live-${String(index).padStart(2, "0")}`;
}

function archivedId(caseName, index) {
	return `benchmark-${caseName}-archived-${String(index).padStart(4, "0")}`;
}

function transcriptContents(session, cwd) {
	const timestamp = new Date(FIXTURE_EPOCH_MS).toISOString();
	return [
		{
			type: "session",
			version: 3,
			id: `transcript-${session.id}`,
			timestamp,
			cwd,
		},
		{
			type: "message",
			id: `entry-${session.id}`,
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `Restorable benchmark transcript ${session.id}` }],
				timestamp: FIXTURE_EPOCH_MS,
			},
		},
	].map(row => JSON.stringify(row)).join("\n") + "\n";
}

/** Pure deterministic manifest used by fixture generation and correctness tests. */
export function buildGatewayStartupFixtureRecords(caseName, { projectRoot, transcriptRoot } = {}) {
	const definition = caseDefinition(caseName);
	const canonicalProjectRoot = projectRoot ?? path.resolve("gateway-startup-fixture-project");
	const canonicalTranscriptRoot = transcriptRoot ?? path.resolve("gateway-startup-fixture-agent", "sessions");
	const archivedCount = definition.sessionCount - definition.liveCount;
	const goalId = definition.sessionCount > 0 ? `benchmark-${caseName}-goal` : null;
	const liveIds = Array.from({ length: definition.liveCount }, (_, index) => liveId(caseName, index));
	const archivedIds = Array.from({ length: archivedCount }, (_, index) => archivedId(caseName, index));
	const sessions = [];

	for (let index = 0; index < definition.liveCount; index += 1) {
		const id = liveIds[index];
		sessions.push({
			id,
			title: `Gateway startup live ${index}`,
			cwd: canonicalProjectRoot,
			agentSessionFile: path.join(canonicalTranscriptRoot, `${id}.jsonl`),
			createdAt: FIXTURE_EPOCH_MS + index,
			lastActivity: FIXTURE_EPOCH_MS + index,
			projectId: GATEWAY_STARTUP_PROJECT_ID,
			wasStreaming: false,
			messageQueue: [],
		});
	}

	for (let index = 0; index < archivedCount; index += 1) {
		const id = archivedIds[index];
		const relationship = {};
		// Concurrent restoration may permute live seed insertion order. Anchor all
		// direct session edges to one seed while retaining every relationship type.
		if (index === 0) relationship.delegateOf = liveIds[0];
		else if (index === 1) relationship.parentSessionId = liveIds[0];
		else if (index === 2) relationship.teamLeadSessionId = liveIds[0];
		else if (index === 3) relationship.goalId = goalId;
		else if (index === 4) relationship.teamGoalId = goalId;
		else if (index === 5) relationship.delegateOf = archivedIds[0];
		else if (index === 6) relationship.parentSessionId = archivedIds[1];
		else if (index === 7) relationship.teamLeadSessionId = archivedIds[2];
		sessions.push({
			id,
			title: index === 0
				? `${GATEWAY_STARTUP_SEARCH_SENTINEL} ${caseName}`
				: `Gateway startup archived ${String(index).padStart(4, "0")}`,
			cwd: canonicalProjectRoot,
			agentSessionFile: "",
			createdAt: FIXTURE_EPOCH_MS + definition.liveCount + index,
			lastActivity: FIXTURE_EPOCH_MS + definition.liveCount + index,
			projectId: GATEWAY_STARTUP_PROJECT_ID,
			archived: true,
			archivedAt: FIXTURE_EPOCH_MS + definition.sessionCount - index,
			...relationship,
		});
	}

	const reachableArchivedIds = archivedIds.slice(0, Math.min(REACHABLE_ARCHIVED_COUNT, archivedIds.length));
	const controlArchivedIds = archivedIds.slice(reachableArchivedIds.length);
	const goal = goalId ? {
		id: goalId,
		title: `Gateway startup relationship goal ${caseName}`,
		cwd: canonicalProjectRoot,
		state: "todo",
		spec: "Deterministic live goal used to seed archived relationship traversal.",
		createdAt: FIXTURE_EPOCH_MS,
		updatedAt: FIXTURE_EPOCH_MS,
		projectId: GATEWAY_STARTUP_PROJECT_ID,
		setupStatus: "ready",
	} : null;
	const semanticProjection = {
		fixtureVersion: GATEWAY_STARTUP_FIXTURE_VERSION,
		caseName,
		projectId: GATEWAY_STARTUP_PROJECT_ID,
		goalId,
		liveIds,
		archivedIds,
		reachableArchivedIds,
		controls: controlArchivedIds,
		sessions: sessions.map(session => ({
			id: session.id,
			title: session.title,
			archived: session.archived === true,
			delegateOf: session.delegateOf ?? null,
			parentSessionId: session.parentSessionId ?? null,
			teamLeadSessionId: session.teamLeadSessionId ?? null,
			teamGoalId: session.teamGoalId ?? null,
			goalId: session.goalId ?? null,
		})),
	};

	return {
		definition,
		sessions,
		goal,
		manifest: {
			...semanticProjection,
			sessionCount: definition.sessionCount,
			liveCount: definition.liveCount,
			archivedCount,
			searchSentinel: definition.sessionCount > 0 ? GATEWAY_STARTUP_SEARCH_SENTINEL : null,
			semanticSha256: sha256(JSON.stringify(semanticProjection)),
		},
	};
}

async function loadProductionFixtureModules(repoRoot) {
	const importBuilt = relative => import(new URL(`../../${relative}`, import.meta.url));
	try {
		const [sessionStoreModule, projectRegistryModule, goalStoreModule, searchModule] = await Promise.all([
			importBuilt("dist/server/agent/session-store.js"),
			importBuilt("dist/server/agent/project-registry.js"),
			importBuilt("dist/server/agent/goal-store.js"),
			importBuilt("dist/server/search/search-service.js"),
		]);
		return {
			SessionStore: sessionStoreModule.SessionStore,
			ProjectRegistry: projectRegistryModule.ProjectRegistry,
			GoalStore: goalStoreModule.GoalStore,
			SearchService: searchModule.SearchService,
		};
	} catch (error) {
		throw new Error(`Built production modules are required; run the benchmark package command after building ${repoRoot}: ${error.message}`);
	}
}

async function seedSearchIndex(SearchService, stateDir, records, goalStore, sessionStore) {
	const service = new SearchService({ stateDir, projectId: GATEWAY_STARTUP_PROJECT_ID });
	service.open({ goalStore, sessionStore });
	try {
		await service.whenReady();
		// The production rebuild boundary owns document preparation, worker RPC,
		// and durable mirror publication. Await it rather than transcribing an
		// index format or relying on fire-and-forget mutation timing.
		await service.rebuildFromStores(goalStore, sessionStore);
		const result = await service.search(
			records.manifest.searchSentinel ?? "gateway-startup-no-match",
			{ type: "sessions", includeArchived: true, limit: 20 },
		);
		const expectedId = records.manifest.archivedIds[0];
		if (expectedId && !result.results.some(row => (row.sessionId ?? row.id) === expectedId)) {
			throw new Error(`Could not build search fixture for ${records.definition.name}`);
		}
	} finally {
		await service.close();
	}
}

/** Generate one immutable canonical fixture using the production persistence writers. */
export async function generateGatewayStartupFixture({ caseName, fixtureRoot, productionModules }) {
	const gatewayRoot = path.join(fixtureRoot, "gateway");
	const stateDir = path.join(gatewayRoot, "state");
	const configDir = path.join(gatewayRoot, "config");
	const projectRoot = path.join(fixtureRoot, "project");
	const transcriptRoot = path.join(fixtureRoot, "agent", "sessions");
	const secretsRoot = path.join(fixtureRoot, "secrets");
	await Promise.all([stateDir, configDir, projectRoot, transcriptRoot, secretsRoot].map(directory => mkdir(directory, { recursive: true })));
	await Promise.all([
		writeFile(path.join(stateDir, "setup-complete"), "benchmark\n", "utf8"),
		writeFile(path.join(secretsRoot, "token"), GATEWAY_STARTUP_TOKEN, "utf8"),
	]);

	const records = buildGatewayStartupFixtureRecords(caseName, { projectRoot, transcriptRoot });
	const { SessionStore, ProjectRegistry, GoalStore, SearchService } = productionModules;
	const projectRegistry = new ProjectRegistry(stateDir);
	projectRegistry.ensureHeadquartersProject(gatewayRoot, { stateDir, configDir });

	const sessionStore = new SessionStore(stateDir);
	for (const session of records.sessions) sessionStore.put(session);
	await sessionStore.flushAsync();

	const goalStore = new GoalStore(stateDir);
	try {
		if (records.goal) {
			goalStore.put(records.goal);
			await goalStore.flush();
		}
		for (const session of records.sessions.slice(0, records.definition.liveCount)) {
			await writeFile(session.agentSessionFile, transcriptContents(session, projectRoot), "utf8");
		}
		await seedSearchIndex(SearchService, stateDir, records, goalStore, sessionStore);
	} finally {
		await goalStore.close();
	}
	await writeFile(path.join(fixtureRoot, "manifest.json"), JSON.stringify(records.manifest, null, 2), "utf8");
	return { fixtureRoot, manifest: records.manifest };
}

async function relocateSampleFixture(sampleFixtureRoot, productionModules) {
	const gatewayRoot = path.join(sampleFixtureRoot, "gateway");
	const stateDir = path.join(gatewayRoot, "state");
	const projectRoot = path.join(sampleFixtureRoot, "project");
	const transcriptRoot = path.join(sampleFixtureRoot, "agent", "sessions");
	const manifest = JSON.parse(await readFile(path.join(sampleFixtureRoot, "manifest.json"), "utf8"));
	const store = new productionModules.SessionStore(stateDir);
	for (const id of manifest.liveIds) {
		const transcript = path.join(transcriptRoot, `${id}.jsonl`);
		store.update(id, { cwd: projectRoot, agentSessionFile: transcript });
		const session = store.get(id);
		assertion(session, `sample relocation could not find ${id}`);
		await writeFile(transcript, transcriptContents(session, projectRoot), "utf8");
	}
	await store.flushAsync();
	return {
		gatewayRoot,
		stateDir,
		projectRoot,
		agentRoot: path.join(sampleFixtureRoot, "agent"),
		secretsRoot: path.join(sampleFixtureRoot, "secrets"),
		manifest,
	};
}

function gatewayEnvironment(sample) {
	return {
		...process.env,
		NODE_ENV: "test",
		BOBBIT_DIR: sample.gatewayRoot,
		BOBBIT_SECRETS_DIR: sample.secretsRoot,
		BOBBIT_AGENT_DIR: sample.agentRoot,
		BOBBIT_NO_OPEN: "1",
		BOBBIT_SKIP_MCP: "1",
		BOBBIT_SKIP_WORKTREE_POOL: "1",
		BOBBIT_SKIP_TITLE_GEN: "1",
		BOBBIT_SKIP_AIGW_DISCOVERY: "1",
		BOBBIT_SKIP_NPM_CI: "1",
		BOBBIT_TEST_NO_PUSH: "1",
		BOBBIT_TEST_NO_REMOTE: "1",
		BOBBIT_TEST_NO_EXTERNAL: "1",
		BOBBIT_LLM_REVIEW_SKIP: "1",
		BOBBIT_E2E_TMP_ROOT: sample.gatewayRoot,
	};
}

async function waitForPublishedGatewayUrl(runtime, stateDir, timeoutMs = URL_TIMEOUT_MS) {
	const gatewayUrlPath = path.join(stateDir, "gateway-url");
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (runtime.spawnError) throw runtime.spawnError;
		if (runtime.exited || runtime.child.exitCode !== null) throw new Error(`Gateway exited before publishing its URL (code ${runtime.child.exitCode ?? "unknown"})`);
		try {
			const raw = (await readFile(gatewayUrlPath, "utf8")).trim();
			if (/^http:\/\/127\.0\.0\.1:\d+$/.test(raw)) return `${raw}/`;
		} catch { /* listener has not published the port yet */ }
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	throw new Error(`Gateway did not publish its port-zero URL within ${timeoutMs}ms`);
}

function authorizedHeaders() {
	return { Authorization: `Bearer ${GATEWAY_STARTUP_TOKEN}` };
}

async function fetchJson(baseUrl, route, { timeoutMs = 10_000 } = {}) {
	const response = await fetch(new URL(route, baseUrl), {
		headers: authorizedHeaders(),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	let body;
	try { body = text ? JSON.parse(text) : null; }
	catch { throw new Error(`${route} returned non-JSON HTTP ${response.status}`); }
	return { response, body };
}

async function validateSearch(baseUrl, manifest) {
	const route = manifest.searchSentinel
		? `api/search?q=${encodeURIComponent(manifest.searchSentinel)}&type=sessions&includeArchived=true&projectId=${GATEWAY_STARTUP_PROJECT_ID}`
		: `api/search?q=${encodeURIComponent("gateway-startup-no-match")}&type=sessions&includeArchived=true&projectId=${GATEWAY_STARTUP_PROJECT_ID}`;
	const deadline = performance.now() + VALIDATION_TIMEOUT_MS;
	let latestStatus = null;
	while (performance.now() < deadline) {
		const { response, body } = await fetchJson(baseUrl, route);
		latestStatus = response.status;
		if (response.ok) {
			const ids = Array.isArray(body?.results) ? body.results.map(result => result.sessionId ?? result.id) : [];
			if (!manifest.searchSentinel || ids.includes(manifest.archivedIds[0])) return { resultIds: ids };
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`search index did not expose its expected sentinel (last HTTP ${latestStatus ?? "unknown"})`);
}

async function validateReadyGateway(baseUrl, manifest) {
	const projectsResult = await fetchJson(baseUrl, "api/projects");
	assertion(projectsResult.response.ok, `projects endpoint returned HTTP ${projectsResult.response.status}`);
	const projects = Array.isArray(projectsResult.body) ? projectsResult.body : projectsResult.body?.projects;
	assertion(Array.isArray(projects), "projects endpoint omitted its list");
	assertion(sameStrings(projects.map(project => project.id), [GATEWAY_STARTUP_PROJECT_ID]), "visible project registry did not contain exactly Headquarters");

	const sessionsResult = await fetchJson(baseUrl, `api/sessions?include=archived&projectId=${GATEWAY_STARTUP_PROJECT_ID}`);
	assertion(sessionsResult.response.ok, `sessions endpoint returned HTTP ${sessionsResult.response.status}`);
	const sessions = sessionsResult.body?.sessions;
	assertion(Array.isArray(sessions), "sessions endpoint omitted its list");
	const actualIds = sessions.map(session => session.id);
	assertion(actualIds.length === manifest.sessionCount, `expected ${manifest.sessionCount} sessions, received ${actualIds.length}`);
	assertion(sameStrings(actualIds, [...manifest.liveIds, ...manifest.archivedIds]), "persisted session IDs changed during startup");
	const archived = sessions.filter(session => session.archived === true || session.status === "archived");
	assertion(archived.length === manifest.archivedCount, `expected ${manifest.archivedCount} archived sessions, received ${archived.length}`);

	const reachable = sessionsResult.body?.archivedDelegates;
	assertion(Array.isArray(reachable), "sessions endpoint omitted archived relationship traversal");
	const reachableIds = reachable.map(session => session.id);
	assertion(
		JSON.stringify(reachableIds) === JSON.stringify(manifest.reachableArchivedIds),
		`archived relationship BFS order changed (expected ${boundedIdArray(manifest.reachableArchivedIds)}, actual ${boundedIdArray(reachableIds)})`,
	);
	const reachableSet = new Set(reachableIds);
	assertion(manifest.controls.every(id => !reachableSet.has(id)), "an unrelated archived control entered relationship traversal");

	const liveStates = [];
	for (const id of manifest.liveIds) {
		const result = await fetchJson(baseUrl, `api/sessions/${encodeURIComponent(id)}`);
		assertion(result.response.ok, `restored session ${id} returned HTTP ${result.response.status}`);
		assertion(result.body?.status === "idle", `restored session ${id} was ${result.body?.status ?? "missing"}, not idle`);
		assertion(!result.body?.restoreError, `restored session ${id} reported a restore error`);
		liveStates.push({ id, status: result.body.status });
	}

	const observedSemantics = validateGatewayStartupSemanticProjection(manifest, sessions);
	const search = await validateSearch(baseUrl, manifest);
	return {
		projectCount: projects.length,
		sessionCount: sessions.length,
		liveCount: liveStates.length,
		archivedCount: archived.length,
		reachableArchivedCount: reachable.length,
		searchResultCount: search.resultIds.length,
		semanticSha256: observedSemantics.semanticSha256,
	};
}

/** Stop one tracked gateway and forget it only after process closure is verified. */
export async function stopTrackedGateway(active, activeGateways, stopGatewayImpl = stopGateway) {
	let result;
	try {
		result = await stopGatewayImpl(active.runtime, {
			baseUrl: active.baseUrl,
			token: GATEWAY_STARTUP_TOKEN,
		});
	} catch (error) {
		throw new Error(`Gateway cleanup failed: ${boundedErrorMessage(error)}`, { cause: error });
	}
	const verifiedClosed = result?.closed === true
		|| (result?.closed !== false && active.runtime?.closed === true);
	if (!verifiedClosed) {
		throw new Error("Gateway cleanup did not verify process closure");
	}
	activeGateways.delete(active);
	return result;
}

/** Retry every retained gateway and aggregate bounded failures after all attempts. */
export async function cleanupTrackedGateways(activeGateways, stopGatewayImpl = stopGateway) {
	const failures = [];
	for (const active of [...activeGateways]) {
		try {
			await stopTrackedGateway(active, activeGateways, stopGatewayImpl);
		} catch (error) {
			failures.push(new Error(boundedErrorMessage(error)));
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, `Gateway cleanup failed for ${failures.length} tracked process${failures.length === 1 ? "" : "es"}`);
	}
}

function aggregateMetricReliability(samples, metric) {
	const observed = sorted(new Set(samples.map(sample => sample.metricReliability?.[metric] ?? "unsupported")));
	return observed.length === 1 ? observed[0] : `mixed (${observed.join(", ")})`;
}

async function runSample(context, entry, canonicalFixture, productionModules, activeGateways) {
	const sampleRoot = await context.createSampleRoot(entry, { fixtureRoot: canonicalFixture.fixtureRoot });
	const sample = await relocateSampleFixture(path.join(sampleRoot, "fixture"), productionModules);
	const runtime = spawnGateway({
		args: [
			path.join(context.repoRoot, "dist", "server", "cli.js"),
			"--host", "127.0.0.1",
			"--port", "0",
			"--cwd", sample.projectRoot,
			"--agent-cli", path.join(context.repoRoot, "tests", "e2e", "mock-agent.mjs"),
			"--no-ui",
			"--no-tls",
			"--auth",
		],
		cwd: context.repoRoot,
		env: gatewayEnvironment(sample),
	});
	const active = { runtime, baseUrl: null };
	activeGateways.add(active);
	const readinessStatuses = [];
	try {
		active.baseUrl = await waitForPublishedGatewayUrl(runtime, sample.stateDir);
		const readiness = await waitForGatewayReady({
			runtime,
			baseUrl: active.baseUrl,
			token: GATEWAY_STARTUP_TOKEN,
			timeoutMs: READY_TIMEOUT_MS,
			pollIntervalMs: 10,
			fetchImpl: async (...args) => {
				const response = await fetch(...args);
				if (readinessStatuses.length < 128) readinessStatuses.push(response.status);
				return response;
			},
		});
		const processMetrics = await readProcessMetrics(runtime.child.pid);
		const correctness = await validateReadyGateway(active.baseUrl, sample.manifest);
		const cpuTimeMs = Number.isFinite(processMetrics.cpuTimeMs) ? processMetrics.cpuTimeMs : null;
		const peakRssBytes = Number.isFinite(processMetrics.peakRssBytes) ? processMetrics.peakRssBytes : null;
		return {
			case: entry.case,
			phase: entry.phase,
			cycle: entry.cycle,
			caseOrder: entry.caseOrder,
			order: entry.order,
			metrics: {
				readyMs: readiness.readyMs,
				cpuTimeMs,
				peakRssBytes,
			},
			metricReliability: {
				readyMs: "reliable",
				cpuTimeMs: cpuTimeMs === null ? "unsupported" : processMetrics.reliability,
				peakRssBytes: peakRssBytes === null ? "unsupported" : processMetrics.reliability,
			},
			readiness: {
				finalStatus: readiness.status,
				observedStartingResponses: readinessStatuses.filter(status => status === 503).length,
				probeCount: readinessStatuses.length,
			},
			correctness,
		};
	} finally {
		await stopTrackedGateway(active, activeGateways);
	}
}

export async function runJourney(context) {
	const productionModules = await loadProductionFixtureModules(context.repoRoot);
	const fixtures = new Map();
	for (const definition of GATEWAY_STARTUP_CASES) {
		const fixtureRoot = path.join(context.paths.fixtures, definition.name);
		fixtures.set(definition.name, await generateGatewayStartupFixture({
			caseName: definition.name,
			fixtureRoot,
			productionModules,
		}));
	}

	const activeGateways = new Set();
	context.deferCleanup(() => cleanupTrackedGateways(activeGateways));

	const schedule = context.scheduleFor(GATEWAY_STARTUP_CASES.map(definition => definition.name));
	const samples = [];
	for (const entry of schedule) {
		samples.push(await runSample(context, entry, fixtures.get(entry.case), productionModules, activeGateways));
	}

	const fixtureDimensions = Object.fromEntries(GATEWAY_STARTUP_CASES.map(definition => {
		const manifest = fixtures.get(definition.name).manifest;
		return [definition.name, {
			sessions: manifest.sessionCount,
			liveSessions: manifest.liveCount,
			archivedSessions: manifest.archivedCount,
			liveGoals: manifest.goalId ? 1 : 0,
			reachableArchivedRelationships: manifest.reachableArchivedIds.length,
			archivedControls: manifest.controls.length,
			searchSentinel: manifest.searchSentinel,
		}];
	}));
	const fixtureHashes = Object.fromEntries(GATEWAY_STARTUP_CASES.map(definition => [
		definition.name,
		fixtures.get(definition.name).manifest.semanticSha256,
	]));
	const cpuTimeReliability = aggregateMetricReliability(samples, "cpuTimeMs");
	const peakRssReliability = aggregateMetricReliability(samples, "peakRssBytes");

	return {
		fixtureDimensions: {
			fixtureVersion: GATEWAY_STARTUP_FIXTURE_VERSION,
			cases: fixtureDimensions,
		},
		fixtureHashes: { semanticProjectionSha256ByCase: fixtureHashes },
		schedule,
		samples,
		metricDefinitions: {
			readyMs: { unit: "ms", direction: "lower", reliability: "reliable" },
			cpuTimeMs: { unit: "ms", direction: "lower", reliability: cpuTimeReliability },
			peakRssBytes: { unit: "bytes", direction: "lower", reliability: peakRssReliability },
		},
		environment: {
			metricSupport: {
				readyMs: "reliable: monotonic process spawn through authenticated health readiness",
				cpuTimeMs: `${cpuTimeReliability}: process-specific child-process CPU time where exposed`,
				peakRssBytes: `${peakRssReliability}: process-specific high-water mark where exposed`,
			},
		},
		correctness: {
			status: "passed",
			sampleCount: samples.length,
			validatedSessions: samples.reduce((sum, sample) => sum + sample.correctness.sessionCount, 0),
			validatedSearchIndexes: samples.length,
			validatedRelationshipTraversals: samples.length,
		},
		interpretation: "Compare readyMs only after every project, session, restoration, archived relationship, and search sentinel check passes. CPU and memory are secondary process metrics.",
		limitations: [
			"Health polling adds up to one polling interval of observation latency.",
			"The listener can become ready before the first probe observes an intermediate HTTP 503 on very small fixtures.",
			"Windows process CPU and peak working set are sampled immediately after readiness and are lower-confidence; macOS peak RSS is unavailable.",
		],
		noiseSources: [
			"Filesystem cache and antivirus scanning",
			"OS process scheduling and concurrent load",
			"CPU frequency scaling and thermal state",
			"Node.js garbage collection and module compilation cache state",
		],
		comparisonMethod: "Run baseline and candidate on the same host, Node version, power state, and fixture version; alternate revisions, verify semantic hashes first, then compare raw samples, median, p95, MAD, and coefficient of variation without applying a correctness-CI latency threshold.",
	};
}

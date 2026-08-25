import { Database as DatabaseIcon, Lightbulb, Route as RouteIcon, ScanLine } from "lucide";
import type { HostApi, HostBobbitSubject, HostProjectSnapshot } from "../../../src/shared/extension-host/host-api.ts";

type TabId = "flow" | "coverage" | "registry" | "benchmarks";
type OperationalState = "active" | "idle" | "paused";
type CoverageState = "scanned" | "stale" | "awaiting";
type FeedKind = "info" | "success" | "warning" | "error";

type ScannerSnapshot = {
	state?: OperationalState;
	activeScans?: number;
	completedLast24h?: number;
	activity?: string;
	lastActivity?: string;
	sessionId?: string;
};

type SessionSummary = { id: string; label: string; detail?: string; sessionId?: string };
type WorkItem = { id: string; label: string; detail?: string; sessionId?: string };

type Hypothesis = {
	id: string;
	title: string;
	status?: string;
	confidence?: number;
	workload?: string;
	summary?: string;
	evidence?: string;
	lastEvidence?: string;
	sessionId?: string;
	goalId?: string;
};

type CoverageNode = {
	id: string;
	label: string;
	kind?: string;
	state?: CoverageState;
	covered?: number;
	total?: number;
	lastScan?: string;
	detail?: string;
	children: CoverageNode[];
};

type FeedEvent = {
	id: string;
	at?: string;
	kind: FeedKind;
	actor: string;
	message: string;
	tab?: TabId;
	sessionId?: string;
};

type BenchmarkReference = {
	id: string;
	name: string;
	component?: string;
	commandName?: string;
	metric?: string;
	unit?: string;
	direction?: "higher" | "lower";
	scanUnitIds: string[];
	fileGlobs: string[];
	tags: string[];
	warmup?: number;
	repetitions?: number;
	stale?: boolean;
};

type BenchmarkRun = {
	id: string;
	hypothesisId?: string;
	benchmarkId: string;
	kind?: "baseline" | "candidate";
	commit?: string;
	metrics: Record<string, number>;
	variability: Record<string, number>;
	interpretation?: string;
	createdAt?: string;
};

type PerformanceOutcome = {
	hypothesisId: string;
	outcome?: string;
	rationale?: string;
	measurementSummary?: string;
	behaviourAssessment?: string;
	complexityAssessment?: string;
	recordedAt?: string;
};

type PerformanceSnapshot = {
	version: 1;
	updatedAt?: string;
	projectName?: string;
	projectGeneratedAt?: number;
	revision?: number;
	scannerStaffId?: string;
	directorStaffId?: string;
	scanner?: ScannerSnapshot;
	registry: Hypothesis[];
	director?: { state?: OperationalState; activeAgents?: number; detail?: string; sessions: SessionSummary[] };
	goals: WorkItem[];
	pullRequests: WorkItem[];
	activity: FeedEvent[];
	coverage: CoverageNode[];
	benchmarks: BenchmarkReference[];
	benchmarkRuns: BenchmarkRun[];
	outcomes: PerformanceOutcome[];
};

type UiPreferences = { version: 1; tab: TabId };

type PaneState = {
	root: HTMLElement;
	styleElement: HTMLStyleElement;
	host?: HostApi;
	tab: TabId;
	snapshot: PerformanceSnapshot | null;
	routeSnapshot: PerformanceSnapshot | null;
	loading: boolean;
	storeState: "unknown" | "ready" | "absent" | "unavailable" | "error";
	storeDiagnostic?: string;
	initialized: boolean;
	demo: boolean;
	liveEvents: FeedEvent[];
	coverageQuery: string;
	registryQuery: string;
	benchmarkQuery: string;
	selectedCoverageId?: string;
	selectedHypothesisId?: string;
	selectedBenchmarkId?: string;
	flowResizeObserver?: ResizeObserver;
	sessionUnsubscribe?: () => void;
	projectUnsubscribes: Array<() => void>;
	projectRefreshSubscribed: boolean;
	subscribedHost?: HostApi;
	hostBindingKey?: string;
	refreshTimer?: number;
	refreshInFlight: boolean;
	refreshPending: boolean;
	refreshGeneration: number;
	routeParamsApplied: boolean;
	routeTab?: TabId;
};

const PANEL_ID = "performance-optimisation.panel";
const ROUTE_ID = "performance-optimisation";
const SNAPSHOT_ROUTE = "performance-snapshot";
const UI_KEY = "control-pane.ui";
const TABS: Array<{ id: TabId; label: string }> = [
	{ id: "flow", label: "Flow map" },
	{ id: "coverage", label: "Scan coverage" },
	{ id: "registry", label: "Hypothesis registry" },
	{ id: "benchmarks", label: "Benchmark store" },
];
const TAB_IDS = new Set<TabId>(TABS.map((tab) => tab.id));
const OPERATIONAL_STATES = new Set<OperationalState>(["active", "idle", "paused"]);
const COVERAGE_STATES = new Set<CoverageState>(["scanned", "stale", "awaiting"]);
const FEED_KINDS = new Set<FeedKind>(["info", "success", "warning", "error"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown, max = 240): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function asCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function asConfidence(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return value;
	if (typeof value !== "string") return undefined;
	if (value.toLowerCase() === "high") return 0.85;
	if (value.toLowerCase() === "medium") return 0.55;
	if (value.toLowerCase() === "low") return 0.25;
	return undefined;
}

function asTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return new Date(value).toISOString();
	return asText(value, 100);
}

function joinedText(value: unknown, max = 240): string | undefined {
	if (Array.isArray(value)) return asText(value.filter((item): item is string => typeof item === "string").join(" · "), max);
	return asText(value, max);
}

function asOperationalState(value: unknown): OperationalState | undefined {
	return typeof value === "string" && OPERATIONAL_STATES.has(value as OperationalState) ? value as OperationalState : undefined;
}

function asCoverageState(value: unknown): CoverageState | undefined {
	return typeof value === "string" && COVERAGE_STATES.has(value as CoverageState) ? value as CoverageState : undefined;
}

function parseScanner(value: unknown): ScannerSnapshot | undefined {
	if (!isObject(value)) return undefined;
	return {
		state: asOperationalState(value.state ?? value.operationalState),
		activeScans: asCount(value.activeScans ?? value.liveActiveScans),
		completedLast24h: asCount(value.completedLast24h ?? value.completedScansLast24h),
		activity: asText(value.activity, 300),
		lastActivity: asText(value.lastActivity ?? value.lastActivityAt, 100),
		sessionId: asText(value.sessionId, 100),
	};
}

function parseSessions(value: unknown): SessionSummary[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 20).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const label = asText(item.label ?? item.name, 120);
		if (!label) return [];
		return [{
			id: asText(item.id, 100) ?? `session-${index}`,
			label,
			detail: asText(item.detail, 160),
			sessionId: asText(item.sessionId, 100),
		}];
	});
}

function parseWorkItems(value: unknown, prefix: string): WorkItem[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];
	return source.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const id = asText(item.goalId ?? item.id, 100) ?? `${prefix}-${index}`;
		const label = asText(item.label ?? item.title ?? item.name ?? item.hypothesisTitle, 160)
			?? (prefix === "goal" ? "Linked performance goal" : undefined);
		if (!label) return [];
		return [{
			id,
			label,
			detail: asText(item.detail ?? item.status ?? item.state ?? item.outcome, 160),
			sessionId: asText(item.sessionId, 100),
		}];
	});
}

function parseHypotheses(value: unknown): Hypothesis[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];
	return source.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const title = asText(item.title ?? item.name ?? item.description, 180);
		if (!title) return [];
		const observations = Array.isArray(item.observations) ? item.observations : [];
		const latestObservation = observations.find(isObject);
		return [{
			id: asText(item.id ?? item.hypothesisId, 100) ?? `hypothesis-${index}`,
			title,
			status: asText(item.status ?? item.schedulingState ?? item.state ?? item.outcome, 60),
			confidence: asConfidence(item.confidence),
			workload: joinedText(item.workload ?? item.improvementTypes ?? item.types ?? item.kind, 100),
			summary: asText(item.summary ?? item.description, 500),
			evidence: asText(item.evidence ?? item.detail ?? latestObservation?.summary ?? latestObservation?.description, 800),
			lastEvidence: asTimestamp(item.lastEvidence ?? item.updatedAt ?? latestObservation?.createdAt),
			sessionId: asText(item.sessionId ?? item.goalClaimSessionId, 100),
			goalId: asText(item.goalId ?? item.linkedGoalId, 100),
		}];
	});
}

function normalizedCoverageState(value: unknown): CoverageState | undefined {
	const direct = asCoverageState(value);
	if (direct) return direct;
	if (value === "scanning" || value === "unscanned") return "awaiting";
	if (value === "failed") return "stale";
	return undefined;
}

function coverageItems(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (!isObject(value)) return [];
	for (const key of ["roots", "items", "units", "scanUnits"] as const) {
		if (Array.isArray(value[key])) return value[key];
	}
	return [
		...(Array.isArray(value.structural) ? value.structural : []),
		...(Array.isArray(value.structuralUnits) ? value.structuralUnits : []),
		...(Array.isArray(value.crossCutting) ? value.crossCutting : []),
		...(Array.isArray(value.crossCuttingUnits) ? value.crossCuttingUnits : []),
	];
}

function parseCoverageNodes(value: unknown, depth = 0, prefix = "coverage"): CoverageNode[] {
	if (depth > 6) return [];
	const parsed = coverageItems(value).slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const label = asText(item.label ?? item.name ?? item.path, 180);
		if (!label) return [];
		const id = asText(item.id ?? item.unitId, 100) ?? `${prefix}-${index}`;
		const files = Array.isArray(item.files) ? item.files.length : undefined;
		return [{
			id,
			label,
			kind: asText(item.kind ?? item.unitKind ?? item.type, 60),
			state: normalizedCoverageState(item.state ?? item.status),
			covered: asCount(item.covered ?? item.scannedFiles),
			total: asCount(item.total ?? item.fileCount ?? files),
			lastScan: asTimestamp(item.lastScan ?? item.lastScannedAt ?? item.scannedAt),
			detail: asText(item.detail ?? item.summary ?? item.attemptSummary, 500),
			children: parseCoverageNodes(item.children, depth + 1, id),
			parentId: asText(item.parentId ?? item.parentUnitId, 100),
		}];
	}) as Array<CoverageNode & { parentId?: string }>;
	if (depth > 0 || !parsed.some((item) => item.parentId)) return parsed;
	const byId = new Map(parsed.map((item) => [item.id, item]));
	const roots: CoverageNode[] = [];
	for (const item of parsed) {
		const parent = item.parentId ? byId.get(item.parentId) : undefined;
		if (parent && parent !== item) parent.children.push(item);
		else roots.push(item);
	}
	return roots;
}

function parseActivity(value: unknown): FeedEvent[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];
	return source.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const message = asText(item.message ?? item.event ?? item.summary ?? item.detail, 500);
		if (!message) return [];
		const rawKind = item.kind ?? item.level;
		const kind = typeof rawKind === "string" && FEED_KINDS.has(rawKind as FeedKind) ? rawKind as FeedKind : "info";
		return [{
			id: asText(item.id ?? item.eventId, 100) ?? `activity-${index}`,
			at: asTimestamp(item.at ?? item.createdAt ?? item.occurredAt ?? item.timestamp),
			kind,
			actor: asText(item.actor ?? item.source ?? item.actorName, 100) ?? "Performance system",
			message,
			tab: parseTab(item.tab ?? item.category),
			sessionId: asText(item.sessionId, 100),
		}];
	});
}

function stringList(value: unknown, limit = 50): string[] {
	return Array.isArray(value)
		? value.slice(0, limit).flatMap((item) => asText(item, 240) ?? [])
		: [];
}

function numberRecord(value: unknown): Record<string, number> {
	if (!isObject(value)) return {};
	return Object.fromEntries(Object.entries(value).slice(0, 50).flatMap(([key, item]) =>
		typeof item === "number" && Number.isFinite(item) ? [[key, item]] : []));
}

function parseBenchmarks(value: unknown): BenchmarkReference[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];
	return source.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const name = asText(item.name ?? item.label, 180);
		if (!name) return [];
		const direction = item.direction === "higher" || item.direction === "lower" ? item.direction : undefined;
		return [{
			id: asText(item.id ?? item.benchmarkId, 100) ?? `benchmark-${index}`,
			name,
			component: asText(item.component, 180),
			commandName: asText(item.commandName ?? item.command, 180),
			metric: asText(item.metric, 120),
			unit: asText(item.unit, 80),
			direction,
			scanUnitIds: stringList(item.scanUnitIds),
			fileGlobs: stringList(item.fileGlobs),
			tags: stringList(item.tags),
			warmup: asCount(item.warmup),
			repetitions: asCount(item.repetitions),
			stale: item.stale === true,
		}];
	});
}

function parseBenchmarkRuns(value: unknown): BenchmarkRun[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];
	return source.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const benchmarkId = asText(item.benchmarkId, 100);
		if (!benchmarkId) return [];
		return [{
			id: asText(item.id ?? item.runId, 100) ?? `run-${index}`,
			hypothesisId: asText(item.hypothesisId, 100),
			benchmarkId,
			kind: item.kind === "baseline" || item.kind === "candidate" ? item.kind : undefined,
			commit: asText(item.commit ?? item.commitSha, 200),
			metrics: numberRecord(item.metrics),
			variability: numberRecord(item.variability),
			interpretation: asText(item.interpretation, 800),
			createdAt: asTimestamp(item.createdAt),
		}];
	});
}

function parseOutcomes(value: unknown): PerformanceOutcome[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];
	return source.slice(0, 100).flatMap((item) => {
		if (!isObject(item)) return [];
		const hypothesisId = asText(item.hypothesisId, 100);
		if (!hypothesisId) return [];
		return [{
			hypothesisId,
			outcome: asText(item.outcome, 180),
			rationale: asText(item.rationale, 1_200),
			measurementSummary: asText(item.measurementSummary, 1_200),
			behaviourAssessment: asText(item.behaviourAssessment, 1_200),
			complexityAssessment: asText(item.complexityAssessment, 1_200),
			recordedAt: asTimestamp(item.recordedAt),
		}];
	});
}

function unwrapRouteResult(value: unknown): unknown {
	let current = value;
	for (let depth = 0; depth < 3 && isObject(current); depth += 1) {
		if (current.ok === true && "value" in current) current = current.value;
		else if ("snapshot" in current && isObject(current.snapshot)) current = current.snapshot;
		else if (current.ok === true && "result" in current) current = current.result;
		else if (current.ok === true && "data" in current) current = current.data;
		else break;
	}
	return current;
}

function parseSnapshot(routeResult: unknown): PerformanceSnapshot | null {
	const value = unwrapRouteResult(routeResult);
	if (!isObject(value) || value.version !== 1) return null;
	const programme = isObject(value.programme) ? value.programme : undefined;
	const settings = isObject(programme?.settings) ? programme.settings : isObject(value.settings) ? value.settings : undefined;
	const directorValue = isObject(value.director) ? value.director : isObject(programme?.director) ? programme.director : undefined;
	const registry = parseHypotheses(value.registry ?? value.hypotheses);
	const linkedGoals = parseWorkItems(value.goals ?? value.goalLinks ?? value.hypothesisGoalLinks, "goal");
	for (const hypothesis of registry) {
		if (hypothesis.goalId && !linkedGoals.some((goal) => goal.id === hypothesis.goalId)) {
			linkedGoals.push({ id: hypothesis.goalId, label: hypothesis.title, detail: hypothesis.status });
		}
	}
	return {
		version: 1,
		updatedAt: asTimestamp(value.updatedAt ?? value.generatedAt ?? programme?.updatedAt),
		revision: asCount(value.revision ?? programme?.revision),
		scannerStaffId: asText(value.scannerStaffId ?? programme?.scannerStaffId ?? settings?.scannerStaffId, 100),
		directorStaffId: asText(value.directorStaffId ?? programme?.directorStaffId ?? settings?.directorStaffId, 100),
		scanner: parseScanner(value.scanner ?? programme?.scanner),
		registry,
		director: directorValue ? {
			state: asOperationalState(directorValue.state ?? directorValue.operationalState),
			activeAgents: asCount(directorValue.activeAgents),
			detail: asText(directorValue.detail ?? directorValue.activity, 240),
			sessions: parseSessions(directorValue.sessions),
		} : undefined,
		goals: linkedGoals,
		pullRequests: parseWorkItems(value.pullRequests ?? value.prs, "pr"),
		activity: parseActivity(value.activity ?? value.activityFeed ?? value.feed),
		coverage: parseCoverageNodes(value.coverage ?? value.scanUnits),
		benchmarks: parseBenchmarks(value.benchmarks),
		benchmarkRuns: parseBenchmarkRuns(value.benchmarkRuns),
		outcomes: parseOutcomes(value.outcomes),
	};
}

const RUNNING_SESSION_STATES = new Set(["running", "streaming", "starting", "initializing", "thinking"]);

function operationalState(staffState: string | undefined, sessions: HostProjectSnapshot["sessions"]): OperationalState {
	if (staffState === "paused") return "paused";
	return sessions.some((session) => RUNNING_SESSION_STATES.has(session.status)) ? "active" : "idle";
}

function staffSessions(project: HostProjectSnapshot, staffId: string | undefined, currentSessionId: string | undefined) {
	if (!staffId && !currentSessionId) return [];
	const related = new Set(project.sessions
		.filter((session) => session.staffId === staffId || session.id === currentSessionId)
		.map((session) => session.id));
	let changed = true;
	while (changed) {
		changed = false;
		for (const session of project.sessions) {
			if (related.has(session.id)) continue;
			if ((session.parentSessionId && related.has(session.parentSessionId)) || (session.delegateOf && related.has(session.delegateOf))) {
				related.add(session.id);
				changed = true;
			}
		}
	}
	return project.sessions.filter((session) => related.has(session.id));
}

function mergeProjectSnapshot(stored: PerformanceSnapshot | null, project: HostProjectSnapshot): PerformanceSnapshot {
	const scannerStaff = project.staff.find((staff) => staff.id === stored?.scannerStaffId)
		?? project.staff.find((staff) => staff.roleId === "performance-scanner");
	const directorStaff = project.staff.find((staff) => staff.id === stored?.directorStaffId)
		?? project.staff.find((staff) => staff.roleId === "optimisation-director");
	const scannerSessions = staffSessions(project, scannerStaff?.id, scannerStaff?.currentSessionId);
	const directorSessions = staffSessions(project, directorStaff?.id, directorStaff?.currentSessionId);
	const newestFirst = (sessions: HostProjectSnapshot["sessions"]) => [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);
	const scannerCurrent = project.sessions.find((session) => session.id === scannerStaff?.currentSessionId) ?? newestFirst(scannerSessions)[0];
	const directorCurrent = project.sessions.find((session) => session.id === directorStaff?.currentSessionId) ?? newestFirst(directorSessions)[0];

	const linkedGoalIds = new Set(stored?.goals.map((goal) => goal.id) ?? []);
	for (const hypothesis of stored?.registry ?? []) if (hypothesis.goalId) linkedGoalIds.add(hypothesis.goalId);
	for (const session of directorSessions) if (session.goalId) linkedGoalIds.add(session.goalId);
	const linkedGoals = project.goals.filter((goal) => linkedGoalIds.has(goal.id));
	const goals = linkedGoals.map((goal): WorkItem => {
		const tasks = project.tasks.filter((task) => task.goalId === goal.id);
		const gates = project.gates.filter((gate) => gate.goalId === goal.id);
		const activeTasks = tasks.filter((task) => task.state === "in-progress").length;
		const blockedTasks = tasks.filter((task) => task.state === "blocked").length;
		const failedGates = gates.filter((gate) => gate.status === "failed").length;
		const detailParts = [goal.paused ? "paused" : goal.state];
		if (activeTasks) detailParts.push(`${activeTasks} active task${activeTasks === 1 ? "" : "s"}`);
		if (blockedTasks) detailParts.push(`${blockedTasks} blocked`);
		if (failedGates) detailParts.push(`${failedGates} failed gate${failedGates === 1 ? "" : "s"}`);
		return {
			id: goal.id,
			label: goal.title,
			detail: detailParts.join(" · "),
			sessionId: newestFirst(project.sessions.filter((session) => session.goalId === goal.id))[0]?.id,
		};
	});

	const pullRequests = project.pullRequests
		.filter((pr) => linkedGoalIds.has(pr.goalId))
		.map((pr): WorkItem => ({
			id: pr.number ? `pr-${pr.number}` : `pr-${pr.goalId}`,
			label: `${pr.number ? `#${pr.number} ` : ""}${pr.title ?? "Pull request"}`,
			detail: [pr.reviewDecision, pr.mergeable, pr.state].filter(Boolean).join(" · "),
			sessionId: newestFirst(project.sessions.filter((session) => session.goalId === pr.goalId))[0]?.id,
		}));

	return {
		version: 1,
		updatedAt: stored?.updatedAt,
		projectName: project.project.name,
		projectGeneratedAt: project.generatedAt,
		revision: stored?.revision,
		scannerStaffId: stored?.scannerStaffId,
		directorStaffId: stored?.directorStaffId,
		scanner: scannerStaff ? {
			...stored?.scanner,
			state: operationalState(scannerStaff.state, scannerSessions),
			activeScans: scannerSessions.filter((session) => RUNNING_SESSION_STATES.has(session.status)).length,
			lastActivity: scannerStaff.lastWakeAt ? new Date(scannerStaff.lastWakeAt).toLocaleString() : stored?.scanner?.lastActivity,
			sessionId: scannerCurrent?.id ?? scannerStaff.currentSessionId,
		} : stored?.scanner,
		registry: stored?.registry ?? [],
		director: directorStaff ? {
			...stored?.director,
			state: operationalState(directorStaff.state, directorSessions),
			activeAgents: directorSessions.filter((session) => RUNNING_SESSION_STATES.has(session.status)).length,
			detail: directorCurrent?.title ?? stored?.director?.detail,
			sessions: newestFirst(directorSessions).slice(0, 20).map((session) => ({
				id: session.id,
				label: session.title,
				detail: session.status,
				sessionId: session.id,
			})),
		} : stored?.director,
		goals,
		pullRequests,
		activity: stored?.activity ?? [],
		coverage: stored?.coverage ?? [],
		benchmarks: stored?.benchmarks ?? [],
		benchmarkRuns: stored?.benchmarkRuns ?? [],
		outcomes: stored?.outcomes ?? [],
	};
}

const DEMO_SNAPSHOT: PerformanceSnapshot = {
	version: 1,
	updatedAt: "Development fixture",
	scannerStaffId: "scanner",
	directorStaffId: "director",
	scanner: { state: "active", activeScans: 2, completedLast24h: 17, activity: "2 delegate scans running", sessionId: "scanner" },
	registry: [
		{ id: "h-047", title: "Avoid duplicate schema parse", status: "Ready", confidence: 0.91, workload: "CPU · agent cold start", summary: "Repeated manifest parsing appears on every tool resolution path.", evidence: "14 matching samples across 3 revisions.", lastEvidence: "2 min ago" },
		{ id: "h-044", title: "Batch websocket event flushes", status: "Promoted", confidence: 0.84, workload: "CPU · server", summary: "Coalesce adjacent writes within the existing flush boundary." },
		{ id: "h-041", title: "Memoise resolved role manifests", status: "In goal", confidence: 0.79, workload: "I/O · agent runtime", summary: "Reuse immutable resolved manifests during session startup." },
	],
	director: {
		state: "active",
		activeAgents: 2,
		detail: "Coordinating benchmark proof",
		sessions: [
			{ id: "director", label: "Noah · Director", detail: "Coordinating proof", sessionId: "director" },
			{ id: "benchmark", label: "Lin · Benchmark", detail: "Running A/B benchmark", sessionId: "benchmark" },
		],
	},
	goals: [
		{ id: "g-186", label: "Reduce WS broadcast copy", detail: "Verifying" },
		{ id: "g-181", label: "Cache config cascade", detail: "In progress" },
	],
	pullRequests: [
		{ id: "pr-842", label: "#842 Batch event flushes", detail: "Checks passing" },
		{ id: "pr-839", label: "#839 Memoise role resolver", detail: "Awaiting review" },
	],
	activity: [
		{ id: "a-1", at: "2025-01-01T12:04:00Z", kind: "success", actor: "Optimisation Director", message: "Created Goal “Async Session Read”", tab: "flow" },
		{ id: "a-2", at: "2025-01-01T12:02:00Z", kind: "success", actor: "Team Lead", message: "Completed Goal “Batch Event Flushes”", tab: "flow" },
		{ id: "a-3", at: "2025-01-01T11:58:00Z", kind: "info", actor: "Optimisation Scanner", message: "Completed scan of DB Layer", tab: "coverage" },
		{ id: "a-4", at: "2025-01-01T11:57:00Z", kind: "info", actor: "Optimisation Scanner", message: "Filed hypothesis “DB Layer N² lookup”", tab: "registry" },
		{ id: "a-5", at: "2025-01-01T11:54:00Z", kind: "success", actor: "Performance Team Lead", message: "Candidate benchmark recorded for session startup", tab: "benchmarks" },
	],
	coverage: [
		{ id: "project", label: "bobbit", kind: "Project", state: "scanned", covered: 83, total: 100, children: [
			{ id: "server", label: "server", kind: "Component", state: "scanned", covered: 92, total: 100, lastScan: "18 min ago", detail: "21 modules · 74 files", children: [
				{ id: "runtime", label: "agent runtime", kind: "Subsystem", state: "scanned", covered: 96, total: 100, children: [
					{ id: "session-manager", label: "session-manager.ts", kind: "File", state: "scanned", children: [] },
					{ id: "pack-resolver", label: "pack-resolver.ts", kind: "File", state: "stale", children: [] },
				] },
				{ id: "websocket", label: "websocket", kind: "Module", state: "scanned", covered: 88, total: 100, children: [
					{ id: "broadcast", label: "broadcast.ts", kind: "File", state: "scanned", children: [] },
					{ id: "message-buffer", label: "message-buffer.ts", kind: "File", state: "awaiting", children: [] },
				] },
			] },
			{ id: "web", label: "web", kind: "Component", state: "stale", covered: 71, total: 100, children: [] },
		] },
	],
	benchmarks: [
		{ id: "bench-startup", name: "Agent session startup", component: "server", commandName: "benchmark:session-startup", metric: "startup p95", unit: "ms", direction: "lower", scanUnitIds: ["runtime"], fileGlobs: ["src/server/agent/**"], tags: ["startup", "runtime"], warmup: 2, repetitions: 12 },
		{ id: "bench-broadcast", name: "WebSocket broadcast throughput", component: "server", commandName: "benchmark:ws-broadcast", metric: "messages", unit: "msg/s", direction: "higher", scanUnitIds: ["websocket"], fileGlobs: ["src/server/ws/**"], tags: ["websocket"], warmup: 3, repetitions: 20 },
		{ id: "bench-render", name: "Message list render", component: "web", commandName: "benchmark:message-render", metric: "frame time", unit: "ms", direction: "lower", scanUnitIds: [], fileGlobs: ["src/ui/**"], tags: ["ui"], warmup: 1, repetitions: 15 },
	],
	benchmarkRuns: [
		{ id: "run-startup-base", hypothesisId: "h-041", benchmarkId: "bench-startup", kind: "baseline", commit: "8d31a40", metrics: { "startup p95": 842 }, variability: { "standard deviation": 17 }, interpretation: "Stable baseline after two warm-up runs.", createdAt: "2025-01-01T10:10:00Z" },
		{ id: "run-startup-candidate", hypothesisId: "h-041", benchmarkId: "bench-startup", kind: "candidate", commit: "b94e1a2", metrics: { "startup p95": 664 }, variability: { "standard deviation": 15 }, interpretation: "21.1% lower p95 across repeated runs.", createdAt: "2025-01-01T11:50:00Z" },
		{ id: "run-broadcast-base", hypothesisId: "h-044", benchmarkId: "bench-broadcast", kind: "baseline", commit: "8d31a40", metrics: { messages: 18420 }, variability: {}, createdAt: "2025-01-01T09:30:00Z" },
	],
	outcomes: [
		{ hypothesisId: "h-041", outcome: "Recommend merging", rationale: "Repeatable startup improvement with unchanged behaviour.", measurementSummary: "p95 improved from 842 ms to 664 ms.", behaviourAssessment: "Session lifecycle tests remained stable.", complexityAssessment: "Small immutable cache with bounded invalidation.", recordedAt: "2025-01-01T12:00:00Z" },
	],
};

function parseTab(value: unknown): TabId | undefined {
	if (value === "overview" || value === "feed") return "flow";
	return typeof value === "string" && TAB_IDS.has(value as TabId) ? value as TabId : undefined;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function button(label: string, action: string, className = "po-button"): HTMLButtonElement {
	const element = node("button", className, label);
	element.type = "button";
	element.dataset.action = action;
	return element;
}

type IconName = "flow" | "scan" | "hypothesis" | "database" | "spark" | "goal" | "activity" | "search" | "arrow";
const ICON_PATHS: Record<IconName, string[]> = {
	flow: ["M6 3v12", "M18 9v12", "M6 15c0 3 3 6 6 6h6", "M6 9h6c3 0 6 3 6 6", "m3 6 3 3 3-3", "m15 12 3 3 3-3"],
	scan: ["M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2", "M8 12h8", "M12 8v8"],
	hypothesis: ["M9 18h6", "M10 22h4", "M8.2 14.8A7 7 0 1 1 15.8 14.8C14.7 15.7 14 16.5 14 18h-4c0-1.5-.7-2.3-1.8-3.2Z"],
	database: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
	spark: ["m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z", "m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"],
	goal: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z", "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"],
	activity: ["M3 12h4l2-7 4 14 2-7h6"],
	search: ["M21 21l-4.3-4.3", "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"],
	arrow: ["M5 12h14", "m13 6 6 6-6 6"],
};

function iconRoot(className: string): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.classList.add(className);
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	return svg;
}

function lucideIcon(name: IconName, className = "po-icon"): SVGSVGElement {
	const svg = iconRoot(className);
	for (const value of ICON_PATHS[name]) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", value);
		svg.append(path);
	}
	return svg;
}

function nativeLucideIcon(icon: Array<[string, Record<string, string | number>]>): SVGSVGElement {
	const svg = iconRoot("po-tab-icon");
	for (const [tag, attributes] of icon) {
		const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, String(value));
		svg.append(child);
	}
	return svg;
}

function emptyState(title: string, detail: string): HTMLElement {
	const wrapper = node("div", "po-empty");
	wrapper.append(node("strong", "", title), node("p", "", detail));
	return wrapper;
}

function countValue(value?: number): string {
	return value === undefined ? "—" : String(value);
}

function sessionButton(state: PaneState, label: string, sessionId?: string): HTMLButtonElement {
	const action = sessionId ? `session:${sessionId}` : "none";
	const result = button(label, action, "po-row-button");
	result.disabled = !sessionId || state.host?.capabilities?.ui !== true || (state.host.contractVersion ?? 1) < 2;
	if (!sessionId) result.title = "No session is linked in the live snapshots";
	else if ((state.host?.contractVersion ?? 1) < 2) result.title = "This host cannot switch to linked sessions";
	return result;
}

function renderTabs(state: PaneState): HTMLElement {
	const nav = node("nav", "po-tabs");
	nav.setAttribute("aria-label", "Performance views");
	nav.setAttribute("role", "tablist");
	const icons = { flow: RouteIcon, coverage: ScanLine, registry: Lightbulb, benchmarks: DatabaseIcon };
	for (const tab of TABS) {
		const tabButton = button("", `tab:${tab.id}`, "po-tab");
		tabButton.append(nativeLucideIcon(icons[tab.id]), node("span", "po-tab-label", tab.label));
		tabButton.id = `po-tab-${tab.id}`;
		// The native sidebar buttons pin this scale inline, which also wins over
		// extension-host button normalisation without requiring core CSS access.
		tabButton.style.fontSize = "1.1667em";
		tabButton.setAttribute("role", "tab");
		tabButton.setAttribute("aria-controls", `po-view-${tab.id}`);
		tabButton.setAttribute("aria-selected", String(state.tab === tab.id));
		tabButton.tabIndex = state.tab === tab.id ? 0 : -1;
		nav.append(tabButton);
	}
	return nav;
}

function activityTime(value?: string): string {
	if (!value) return "Time not reported";
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return value;
	return new Date(parsed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function newestActivity(state: PaneState): FeedEvent[] {
	return [...state.liveEvents, ...(state.snapshot?.activity ?? [])]
		.map((event, index) => ({ event, index, timestamp: event.at ? Date.parse(event.at) : Number.NaN }))
		.sort((a, b) => {
			if (Number.isNaN(a.timestamp) && Number.isNaN(b.timestamp)) return a.index - b.index;
			if (Number.isNaN(a.timestamp)) return 1;
			if (Number.isNaN(b.timestamp)) return -1;
			return b.timestamp - a.timestamp;
		})
		.slice(0, 50)
		.map(({ event }) => event);
}

function renderActivity(state: PaneState): HTMLElement {
	const section = node("section", "po-activity");
	const head = node("div", "po-section-head");
	const copy = node("div");
	copy.append(node("p", "po-eyebrow", "Programme log"), node("h2", "", "Live activity"));
	const events = newestActivity(state);
	head.append(copy, node("span", "po-count", `${events.length} / 50`));
	section.append(head);
	if (!events.length) {
		section.append(emptyState("No activity yet", "Programme events will appear here as work is recorded."));
		return section;
	}
	const feed = node("ol", "po-feed");
	feed.setAttribute("aria-label", "Live optimisation activity");
	feed.setAttribute("aria-live", "polite");
	for (const event of events) {
		const item = node("li", `po-feed-row is-${event.kind}`);
		const time = node("time", "", activityTime(event.at));
		if (event.at) time.dateTime = event.at;
		item.append(node("span", "po-feed-indicator"), time, node("strong", "", event.actor), node("span", "po-feed-message", event.message));
		if (event.sessionId) item.append(sessionButton(state, "Open", event.sessionId));
		else if (event.tab) {
			const action = button("View", `navigate:${event.tab}`, "po-feed-action");
			action.disabled = state.host?.capabilities?.ui !== true;
			item.append(action);
		} else item.append(node("span", "po-feed-empty-action", "—"));
		feed.append(item);
	}
	section.append(feed);
	return section;
}

type FlowNodeId = "scanner" | "coverage" | "ideators" | "hypotheses" | "director" | "goals" | "benchmarks";
type FlowEdgeCategory = "discovery" | "ideation" | "scheduling" | "measurement";
type FlowEdge = { id: string; from: FlowNodeId; to: FlowNodeId; tool: string; category: FlowEdgeCategory };

// Reads flow from the durable store to their consumer; writes and orchestration
// flow from the acting process to their destination.
const FLOW_EDGES: FlowEdge[] = [
	{ id: "refresh-coverage", from: "scanner", to: "coverage", tool: "perf_coverage_refresh", category: "discovery" },
	{ id: "select-coverage", from: "coverage", to: "scanner", tool: "perf_coverage_get_modules_to_scan", category: "discovery" },
	{ id: "delegate-ideator", from: "scanner", to: "ideators", tool: "team_delegate", category: "ideation" },
	{ id: "seal-coverage", from: "ideators", to: "coverage", tool: "perf_coverage_mark_module_as", category: "discovery" },
	{ id: "publish-hypothesis", from: "ideators", to: "hypotheses", tool: "perf_hypothesis_create", category: "ideation" },
	{ id: "rank-hypothesis", from: "hypotheses", to: "director", tool: "perf_hypothesis_get_highest_priority", category: "scheduling" },
	{ id: "create-goal", from: "director", to: "goals", tool: "bobbit_orchestrate.create_goal", category: "scheduling" },
	{ id: "select-benchmark", from: "benchmarks", to: "goals", tool: "perf_benchmark_list", category: "measurement" },
	{ id: "record-run", from: "goals", to: "benchmarks", tool: "perf_benchmark_record_run", category: "measurement" },
	{ id: "record-outcome", from: "goals", to: "hypotheses", tool: "perf_hypothesis_record_outcome", category: "measurement" },
];

type FlowRoute = { id: string; from: FlowNodeId; to: FlowNodeId; tools: string[]; category: FlowEdgeCategory; bidirectional: boolean };

function groupedFlowRoutes(): FlowRoute[] {
	const routes = new Map<string, FlowRoute>();
	for (const edge of FLOW_EDGES) {
		const key = [edge.from, edge.to].sort().join(":");
		const existing = routes.get(key);
		if (existing) {
			existing.tools.push(edge.tool);
			if (existing.from === edge.to && existing.to === edge.from) existing.bidirectional = true;
		} else routes.set(key, { id: edge.id, from: edge.from, to: edge.to, tools: [edge.tool], category: edge.category, bidirectional: false });
	}
	return [...routes.values()];
}

const FLOW_ROUTES = groupedFlowRoutes();

function metricBlock(value: string, label: string): HTMLElement {
	const metric = node("div", "po-map-metric");
	metric.append(node("strong", "", value), node("span", "", label));
	return metric;
}

const STORE_CONTENT_INSETS = { top: 46, right: 12, bottom: 25, left: 12 } as const;

function cylinderGeometry(): SVGSVGElement {
	const svg = svgElement("svg");
	svg.classList.add("po-cylinder");
	svg.setAttribute("viewBox", "0 0 100 100");
	svg.setAttribute("preserveAspectRatio", "none");
	svg.setAttribute("aria-hidden", "true");
	const body = svgElement("rect");
	body.classList.add("po-cylinder-body");
	body.setAttribute("x", "2");
	body.setAttribute("y", "12");
	body.setAttribute("width", "96");
	body.setAttribute("height", "76");
	const bottom = svgElement("ellipse");
	bottom.classList.add("po-cylinder-body", "po-cylinder-bottom");
	bottom.setAttribute("cx", "50");
	bottom.setAttribute("cy", "88");
	bottom.setAttribute("rx", "48");
	bottom.setAttribute("ry", "11");
	const sides = svgElement("path");
	sides.classList.add("po-cylinder-outline");
	sides.setAttribute("d", "M2 12V88 M98 12V88 M2 88 A48 11 0 0 0 98 88");
	const cap = svgElement("ellipse");
	cap.classList.add("po-cylinder-cap");
	cap.setAttribute("cx", "50");
	cap.setAttribute("cy", "12");
	cap.setAttribute("rx", "48");
	cap.setAttribute("ry", "11");
	svg.append(body, bottom, sides, cap);
	return svg;
}

function hostBobbitSprite(state: PaneState, label: string, stateValue: OperationalState | undefined, subject: HostBobbitSubject): HTMLElement {
	if (!state.host) throw new Error("Performance panel requires its bound Host API");
	return state.host.ui.createBobbitSprite({ subject, state: stateValue ?? "idle", label: `${label} Bobbit avatar`, size: 40, animated: true });
}

function bobbitSubject(staffId: string | undefined, sessionId: string | undefined): HostBobbitSubject {
	return staffId ? { kind: "staff", id: staffId } : { kind: "session", id: sessionId ?? "" };
}

function flowNode(
	id: FlowNodeId,
	title: string,
	kind: "staff" | "process" | "store",
	metric: { value: string; label: string },
	stateValue: OperationalState | undefined,
	action?: { label: string; value: string; disabled?: boolean },
	avatar?: HTMLElement,
): HTMLElement {
	const article = node("article", `po-map-node is-${kind}`);
	article.dataset.flowNode = id;
	article.dataset.nodeState = stateValue ?? "unknown";
	if (kind === "store") {
		article.dataset.contentInset = `${STORE_CONTENT_INSETS.top} ${STORE_CONTENT_INSETS.right} ${STORE_CONTENT_INSETS.bottom} ${STORE_CONTENT_INSETS.left}`;
		article.append(cylinderGeometry());
	}
	const content = node("div", "po-map-node-content");
	const head = node("div", "po-map-node-head");
	const identity = node("div", "po-map-identity");
	identity.append(node("span", "po-map-kind", kind === "store" ? "Evidence store" : kind === "staff" ? "Persistent staff" : "Execution process"), node("h3", "", title));
	if (avatar) head.append(avatar);
	else {
		const glyph = node("span", "po-map-glyph");
		glyph.append(lucideIcon(kind === "store" ? "database" : id === "goals" ? "goal" : "spark"));
		head.append(glyph);
	}
	head.append(identity);
	if (stateValue) {
		const label = `${stateValue[0].toUpperCase()}${stateValue.slice(1)}`;
		const status = node("span", `po-map-status is-${stateValue}`);
		status.title = label;
		status.setAttribute("aria-label", label);
		head.append(status);
	}
	content.append(head, metricBlock(metric.value, metric.label));
	if (action) {
		const detail = button(action.label, action.value, "po-map-action");
		detail.disabled = action.disabled === true;
		detail.append(lucideIcon("arrow"));
		content.append(detail);
	}
	article.append(content);
	return article;
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
	return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function renderFlowEdges(): SVGSVGElement {
	const svg = svgElement("svg");
	svg.classList.add("po-map-edges");
	svg.setAttribute("aria-label", "Performance programme tool-call routes");
	const defs = svgElement("defs");
	const marker = svgElement("marker");
	marker.id = "po-flow-arrow";
	marker.setAttribute("viewBox", "0 0 8 8");
	marker.setAttribute("refX", "7");
	marker.setAttribute("refY", "4");
	marker.setAttribute("markerWidth", "6");
	marker.setAttribute("markerHeight", "6");
	marker.setAttribute("orient", "auto-start-reverse");
	const arrow = svgElement("path");
	arrow.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
	marker.append(arrow);
	defs.append(marker);
	svg.append(defs);
	for (const route of FLOW_ROUTES) {
		const group = svgElement("g");
		group.classList.add("po-edge", `is-${route.category}`);
		group.dataset.edge = route.id;
		group.dataset.tools = route.tools.join(", ");
		group.setAttribute("tabindex", "0");
		group.setAttribute("role", "img");
		group.setAttribute("aria-label", `${route.tools.join(", ")}: ${route.from} ${route.bidirectional ? "and" : "to"} ${route.to}${route.bidirectional ? " (bidirectional)" : ""}`);
		group.setAttribute("aria-describedby", `po-edge-tip-${route.id}`);
		const setTooltipVisible = (visible: boolean) => {
			group.closest(".po-map-layout")?.querySelector<HTMLElement>(`[data-edge-tip="${route.id}"]`)?.classList.toggle("is-visible", visible);
		};
		group.addEventListener("pointerenter", () => setTooltipVisible(true));
		group.addEventListener("pointerleave", () => setTooltipVisible(false));
		group.addEventListener("focus", () => setTooltipVisible(true));
		group.addEventListener("blur", () => setTooltipVisible(false));
		const halo = svgElement("path");
		halo.classList.add("po-edge-hit");
		const path = svgElement("path");
		path.classList.add("po-edge-line");
		path.setAttribute("marker-end", "url(#po-flow-arrow)");
		if (route.bidirectional) path.setAttribute("marker-start", "url(#po-flow-arrow)");
		group.append(halo, path);
		svg.append(group);
	}
	return svg;
}

function renderFlowTooltips(): HTMLElement {
	const layer = node("div", "po-edge-tooltips");
	layer.setAttribute("aria-live", "off");
	for (const route of FLOW_ROUTES) {
		const tip = node("div", "po-edge-tip");
		tip.id = `po-edge-tip-${route.id}`;
		tip.dataset.edgeTip = route.id;
		tip.setAttribute("role", "tooltip");
		const body = node("div", "po-edge-tip-body");
		for (const tool of route.tools) body.append(node("code", "", tool));
		tip.append(body);
		layer.append(tip);
	}
	return layer;
}

type FlowLayoutMode = "STORE_ROW" | "STORE_COLUMN" | "SINGLE_COLUMN";
type FlowSide = "NORTH" | "EAST" | "SOUTH" | "WEST";
type FlowPoint = { x: number; y: number };
type FlowBounds = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type FlowRouteGeometry = { path: string; midpoint: FlowPoint; kind: "straight" | "s-bend" | "outer-gutter" };

const FLOW_WIDE_BREAKPOINT = 900;
const FLOW_NARROW_BREAKPOINT = 520;
const FLOW_NODE_ORDER: FlowNodeId[] = ["scanner", "coverage", "ideators", "hypotheses", "director", "goals", "benchmarks"];

function flowLayoutMode(canvas: HTMLElement): FlowLayoutMode {
	if (canvas.clientWidth >= FLOW_WIDE_BREAKPOINT) return "STORE_ROW";
	if (canvas.clientWidth >= FLOW_NARROW_BREAKPOINT) return "STORE_COLUMN";
	return "SINGLE_COLUMN";
}

function flowBounds(layout: HTMLElement, id: FlowNodeId): FlowBounds | undefined {
	const element = layout.querySelector<HTMLElement>(`[data-flow-node="${id}"]`);
	if (!element) return undefined;
	return {
		left: element.offsetLeft,
		top: element.offsetTop,
		right: element.offsetLeft + element.offsetWidth,
		bottom: element.offsetTop + element.offsetHeight,
		width: element.offsetWidth,
		height: element.offsetHeight,
	};
}

function flowAnchor(bounds: FlowBounds, side: FlowSide, offset = 0): FlowPoint {
	if (side === "NORTH") return { x: bounds.left + bounds.width / 2 + offset, y: bounds.top };
	if (side === "SOUTH") return { x: bounds.left + bounds.width / 2 + offset, y: bounds.bottom };
	if (side === "WEST") return { x: bounds.left, y: bounds.top + bounds.height / 2 + offset };
	return { x: bounds.right, y: bounds.top + bounds.height / 2 + offset };
}

function routePortSides(route: FlowRoute, mode: FlowLayoutMode): { from: FlowSide; to: FlowSide } {
	if (mode === "SINGLE_COLUMN") {
		if (route.id === "delegate-ideator") return { from: "WEST", to: "WEST" };
		if (route.id === "seal-coverage" || route.id === "record-outcome") return { from: "EAST", to: "EAST" };
		if (route.id === "select-benchmark") return { from: "NORTH", to: "SOUTH" };
		return { from: "SOUTH", to: "NORTH" };
	}
	if (mode === "STORE_COLUMN") {
		if (route.id === "refresh-coverage" || route.id === "publish-hypothesis") return { from: "EAST", to: "WEST" };
		if (route.id === "select-benchmark") return { from: "WEST", to: "EAST" };
		if (route.id === "seal-coverage") return { from: "NORTH", to: "SOUTH" };
		if (route.id === "rank-hypothesis") return { from: "SOUTH", to: "NORTH" };
		if (route.id === "record-outcome") return { from: "NORTH", to: "SOUTH" };
		return { from: "SOUTH", to: "NORTH" };
	}
	if (route.id === "refresh-coverage" || route.id === "publish-hypothesis") return { from: "SOUTH", to: "NORTH" };
	if (route.id === "select-benchmark") return { from: "NORTH", to: "SOUTH" };
	if (route.id === "rank-hypothesis") return { from: "EAST", to: "SOUTH" };
	if (route.id === "seal-coverage") return { from: "SOUTH", to: "NORTH" };
	if (route.id === "record-outcome") return { from: "NORTH", to: "NORTH" };
	return { from: "EAST", to: "WEST" };
}

function sideVector(side: FlowSide): FlowPoint {
	if (side === "NORTH") return { x: 0, y: -1 };
	if (side === "SOUTH") return { x: 0, y: 1 };
	if (side === "WEST") return { x: -1, y: 0 };
	return { x: 1, y: 0 };
}

function pointText(point: FlowPoint): string {
	return `${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
}

type PortAllocation = { offset: number; fraction: number };

function allocateRoutePorts(mode: FlowLayoutMode, nodeBounds: Map<FlowNodeId, FlowBounds>): Map<string, PortAllocation> {
	type Endpoint = { routeId: string; endpoint: "from" | "to"; nodeId: FlowNodeId; side: FlowSide };
	const groups = new Map<string, Endpoint[]>();
	for (const route of FLOW_ROUTES) {
		const sides = routePortSides(route, mode);
		for (const endpoint of [
			{ routeId: route.id, endpoint: "from" as const, nodeId: route.from, side: sides.from },
			{ routeId: route.id, endpoint: "to" as const, nodeId: route.to, side: sides.to },
		]) {
			const key = `${endpoint.nodeId}:${endpoint.side}`;
			const values = groups.get(key) ?? [];
			values.push(endpoint);
			groups.set(key, values);
		}
	}
	const allocations = new Map<string, PortAllocation>();
	for (const endpoints of groups.values()) {
		const bounds = nodeBounds.get(endpoints[0].nodeId);
		if (!bounds) continue;
		const extent = endpoints[0].side === "NORTH" || endpoints[0].side === "SOUTH" ? bounds.width : bounds.height;
		for (let index = 0; index < endpoints.length; index += 1) {
			const fraction = (index + 1) / (endpoints.length + 1);
			allocations.set(`${endpoints[index].routeId}:${endpoints[index].endpoint}`, { fraction, offset: (fraction - 0.5) * extent });
		}
	}
	return allocations;
}

type RouteSegment = { start: FlowPoint; end: FlowPoint };
type RoutingGraph = { points: FlowPoint[]; neighbours: Array<Array<{ index: number; length: number; orientation: "H" | "V" }>> };

const ROUTE_NODE_HALO = 14;
const ROUTE_PORT_LEAD = 24;
const ROUTE_MIN_TERMINAL_GAP = 16;
const ROUTE_BEND_PENALTY = 46;
const ROUTE_CROSSING_PENALTY = 140;
const ROUTE_OVERLAP_PENALTY = 180;
const ROUTE_CORNER_RADIUS = 13;
const ROUTE_EPSILON = 0.1;

function inflateBounds(bounds: FlowBounds, amount: number): FlowBounds {
	return { left: bounds.left - amount, top: bounds.top - amount, right: bounds.right + amount, bottom: bounds.bottom + amount, width: bounds.width + amount * 2, height: bounds.height + amount * 2 };
}

function pointInsideObstacle(point: FlowPoint, obstacle: FlowBounds): boolean {
	return point.x > obstacle.left + ROUTE_EPSILON && point.x < obstacle.right - ROUTE_EPSILON && point.y > obstacle.top + ROUTE_EPSILON && point.y < obstacle.bottom - ROUTE_EPSILON;
}

function segmentClear(start: FlowPoint, end: FlowPoint, obstacles: FlowBounds[]): boolean {
	for (const obstacle of obstacles) {
		if (Math.abs(start.y - end.y) < ROUTE_EPSILON) {
			if (start.y <= obstacle.top + ROUTE_EPSILON || start.y >= obstacle.bottom - ROUTE_EPSILON) continue;
			if (Math.max(Math.min(start.x, end.x), obstacle.left) < Math.min(Math.max(start.x, end.x), obstacle.right) - ROUTE_EPSILON) return false;
		} else {
			if (start.x <= obstacle.left + ROUTE_EPSILON || start.x >= obstacle.right - ROUTE_EPSILON) continue;
			if (Math.max(Math.min(start.y, end.y), obstacle.top) < Math.min(Math.max(start.y, end.y), obstacle.bottom) - ROUTE_EPSILON) return false;
		}
	}
	return true;
}

function channelValues(obstacles: FlowBounds[], startLead: FlowPoint, endLead: FlowPoint, width: number, height: number): { xs: number[]; ys: number[] } {
	const xs = new Set<number>([18, width - 18, startLead.x, endLead.x]);
	const ys = new Set<number>([18, height - 18, startLead.y, endLead.y]);
	for (const obstacle of obstacles) {
		xs.add(obstacle.left); xs.add(obstacle.right);
		ys.add(obstacle.top); ys.add(obstacle.bottom);
	}
	const sortedXBounds = [...obstacles].sort((a, b) => a.left - b.left);
	const sortedYBounds = [...obstacles].sort((a, b) => a.top - b.top);
	for (let index = 1; index < sortedXBounds.length; index += 1) {
		const gapStart = sortedXBounds[index - 1].right;
		const gapEnd = sortedXBounds[index].left;
		if (gapEnd - gapStart > ROUTE_NODE_HALO) xs.add((gapStart + gapEnd) / 2);
	}
	for (let index = 1; index < sortedYBounds.length; index += 1) {
		const gapStart = sortedYBounds[index - 1].bottom;
		const gapEnd = sortedYBounds[index].top;
		if (gapEnd - gapStart > ROUTE_NODE_HALO) ys.add((gapStart + gapEnd) / 2);
	}
	return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
}

function buildRoutingGraph(obstacles: FlowBounds[], startLead: FlowPoint, endLead: FlowPoint, width: number, height: number): RoutingGraph {
	const { xs, ys } = channelValues(obstacles, startLead, endLead, width, height);
	const points: FlowPoint[] = [];
	const indexByCoordinate = new Map<string, number>();
	const key = (x: number, y: number) => `${x.toFixed(2)}:${y.toFixed(2)}`;
	for (const x of xs) for (const y of ys) {
		const point = { x, y };
		if (obstacles.some((obstacle) => pointInsideObstacle(point, obstacle))) continue;
		indexByCoordinate.set(key(x, y), points.length);
		points.push(point);
	}
	const neighbours: RoutingGraph["neighbours"] = points.map(() => []);
	const connect = (first: number, second: number, orientation: "H" | "V") => {
		const start = points[first];
		const end = points[second];
		if (!segmentClear(start, end, obstacles)) return;
		const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
		neighbours[first].push({ index: second, length, orientation });
		neighbours[second].push({ index: first, length, orientation });
	};
	for (const y of ys) {
		const row = xs.map((x) => indexByCoordinate.get(key(x, y))).filter((index): index is number => index !== undefined);
		for (let index = 1; index < row.length; index += 1) connect(row[index - 1], row[index], "H");
	}
	for (const x of xs) {
		const column = ys.map((y) => indexByCoordinate.get(key(x, y))).filter((index): index is number => index !== undefined);
		for (let index = 1; index < column.length; index += 1) connect(column[index - 1], column[index], "V");
	}
	return { points, neighbours };
}

function crossingCost(segment: RouteSegment, routed: RouteSegment[]): number {
	let cost = 0;
	const horizontal = Math.abs(segment.start.y - segment.end.y) < ROUTE_EPSILON;
	for (const existing of routed) {
		const existingHorizontal = Math.abs(existing.start.y - existing.end.y) < ROUTE_EPSILON;
		if (horizontal !== existingHorizontal) {
			const horizontalSegment = horizontal ? segment : existing;
			const verticalSegment = horizontal ? existing : segment;
			const crosses = verticalSegment.start.x > Math.min(horizontalSegment.start.x, horizontalSegment.end.x) + ROUTE_EPSILON
				&& verticalSegment.start.x < Math.max(horizontalSegment.start.x, horizontalSegment.end.x) - ROUTE_EPSILON
				&& horizontalSegment.start.y > Math.min(verticalSegment.start.y, verticalSegment.end.y) + ROUTE_EPSILON
				&& horizontalSegment.start.y < Math.max(verticalSegment.start.y, verticalSegment.end.y) - ROUTE_EPSILON;
			if (crosses) cost += ROUTE_CROSSING_PENALTY;
			continue;
		}
		const sameLine = horizontal
			? Math.abs(segment.start.y - existing.start.y) < ROUTE_EPSILON
			: Math.abs(segment.start.x - existing.start.x) < ROUTE_EPSILON;
		if (!sameLine) continue;
		const firstStart = horizontal ? segment.start.x : segment.start.y;
		const firstEnd = horizontal ? segment.end.x : segment.end.y;
		const secondStart = horizontal ? existing.start.x : existing.start.y;
		const secondEnd = horizontal ? existing.end.x : existing.end.y;
		const overlap = Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd)) - Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd));
		if (overlap > ROUTE_EPSILON) cost += ROUTE_OVERLAP_PENALTY + overlap;
	}
	return cost;
}

function terminalLeadLength(start: FlowPoint, end: FlowPoint, fromVector: FlowPoint, toVector: FlowPoint): number {
	const delta = { x: end.x - start.x, y: end.y - start.y };
	const distance = Math.abs(delta.x) + Math.abs(delta.y);
	const fromFacesEnd = delta.x * fromVector.x + delta.y * fromVector.y > 0;
	const toFacesStart = -delta.x * toVector.x - delta.y * toVector.y > 0;
	const axisAligned = Math.abs(delta.x) < ROUTE_EPSILON || Math.abs(delta.y) < ROUTE_EPSILON;
	if (!axisAligned || !fromFacesEnd || !toFacesStart) return ROUTE_PORT_LEAD;
	return Math.max(0, Math.min(ROUTE_PORT_LEAD, (distance - ROUTE_MIN_TERMINAL_GAP) / 2));
}

function preferredPortAlignedRoute(
	startLead: FlowPoint,
	endLead: FlowPoint,
	sides: { from: FlowSide; to: FlowSide },
	obstacles: FlowBounds[],
	routed: RouteSegment[],
): FlowPoint[] | undefined {
	if (sides.from === sides.to) return undefined;
	const fromHorizontal = sides.from === "EAST" || sides.from === "WEST";
	const toHorizontal = sides.to === "EAST" || sides.to === "WEST";
	const candidates: FlowPoint[][] = fromHorizontal === toHorizontal
		? fromHorizontal
			? [[startLead, { x: endLead.x, y: startLead.y }, endLead], [startLead, { x: startLead.x, y: endLead.y }, endLead]]
			: [[startLead, { x: startLead.x, y: endLead.y }, endLead], [startLead, { x: endLead.x, y: startLead.y }, endLead]]
		: [fromHorizontal
			? [startLead, { x: endLead.x, y: startLead.y }, endLead]
			: [startLead, { x: startLead.x, y: endLead.y }, endLead]];
	let best: { points: FlowPoint[]; cost: number } | undefined;
	for (const candidate of candidates) {
		const points = simplifyRoutePoints(candidate);
		const segments = points.slice(1).map((point, index) => ({ start: points[index], end: point }));
		if (segments.some((segment) => !segmentClear(segment.start, segment.end, obstacles))) continue;
		const length = segments.reduce((sum, segment) => sum + Math.abs(segment.end.x - segment.start.x) + Math.abs(segment.end.y - segment.start.y), 0);
		const cost = length + Math.max(0, segments.length - 1) * ROUTE_BEND_PENALTY
			+ segments.reduce((sum, segment) => sum + crossingCost(segment, routed), 0);
		if (!best || cost < best.cost) best = { points, cost };
	}
	return best?.points;
}

function shortestChannelRoute(graph: RoutingGraph, startLead: FlowPoint, endLead: FlowPoint, routed: RouteSegment[]): FlowPoint[] {
	const findPoint = (target: FlowPoint) => graph.points.findIndex((point) => Math.abs(point.x - target.x) < ROUTE_EPSILON && Math.abs(point.y - target.y) < ROUTE_EPSILON);
	const startIndex = findPoint(startLead);
	const endIndex = findPoint(endLead);
	if (startIndex < 0 || endIndex < 0) return [startLead, endLead];
	type Orientation = "H" | "V" | "S";
	const stateKey = (index: number, orientation: Orientation) => `${index}:${orientation}`;
	const distances = new Map<string, number>([[stateKey(startIndex, "S"), 0]]);
	const previous = new Map<string, string>();
	const pending = new Set<string>([stateKey(startIndex, "S")]);
	let finalKey: string | undefined;
	while (pending.size) {
		let currentKey = "";
		let currentDistance = Number.POSITIVE_INFINITY;
		for (const candidate of pending) {
			const distance = distances.get(candidate) ?? Number.POSITIVE_INFINITY;
			if (distance < currentDistance) { currentKey = candidate; currentDistance = distance; }
		}
		pending.delete(currentKey);
		const [indexText, incomingText] = currentKey.split(":");
		const pointIndex = Number(indexText);
		const incoming = incomingText as Orientation;
		if (pointIndex === endIndex) { finalKey = currentKey; break; }
		for (const neighbour of graph.neighbours[pointIndex]) {
			const segment = { start: graph.points[pointIndex], end: graph.points[neighbour.index] };
			const bendCost = incoming !== "S" && incoming !== neighbour.orientation ? ROUTE_BEND_PENALTY : 0;
			const nextDistance = currentDistance + neighbour.length + bendCost + crossingCost(segment, routed);
			const nextKey = stateKey(neighbour.index, neighbour.orientation);
			if (nextDistance >= (distances.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
			distances.set(nextKey, nextDistance);
			previous.set(nextKey, currentKey);
			pending.add(nextKey);
		}
	}
	if (!finalKey) return [startLead, endLead];
	const result: FlowPoint[] = [];
	for (let key: string | undefined = finalKey; key; key = previous.get(key)) result.push(graph.points[Number(key.split(":")[0])]);
	return result.reverse();
}

function simplifyRoutePoints(points: FlowPoint[]): FlowPoint[] {
	const unique = points.filter((point, index) => index === 0 || Math.abs(point.x - points[index - 1].x) > ROUTE_EPSILON || Math.abs(point.y - points[index - 1].y) > ROUTE_EPSILON);
	return unique.filter((point, index) => {
		if (index === 0 || index === unique.length - 1) return true;
		const previous = unique[index - 1];
		const next = unique[index + 1];
		return !((Math.abs(previous.x - point.x) < ROUTE_EPSILON && Math.abs(point.x - next.x) < ROUTE_EPSILON)
			|| (Math.abs(previous.y - point.y) < ROUTE_EPSILON && Math.abs(point.y - next.y) < ROUTE_EPSILON));
	});
}

function roundedChannelPath(points: FlowPoint[]): FlowRouteGeometry {
	const route = simplifyRoutePoints(points);
	if (route.length < 2) return { path: "", midpoint: route[0] ?? { x: 0, y: 0 }, kind: "straight" };
	let path = `M ${pointText(route[0])}`;
	for (let index = 1; index < route.length - 1; index += 1) {
		const previous = route[index - 1];
		const corner = route[index];
		const next = route[index + 1];
		const incomingLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
		const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
		const radius = Math.min(ROUTE_CORNER_RADIUS, incomingLength / 3, outgoingLength / 3);
		const incoming = { x: (corner.x - previous.x) / incomingLength, y: (corner.y - previous.y) / incomingLength };
		const outgoing = { x: (next.x - corner.x) / outgoingLength, y: (next.y - corner.y) / outgoingLength };
		const before = { x: corner.x - incoming.x * radius, y: corner.y - incoming.y * radius };
		const after = { x: corner.x + outgoing.x * radius, y: corner.y + outgoing.y * radius };
		const controlScale = radius * 0.5523;
		const control1 = { x: before.x + incoming.x * controlScale, y: before.y + incoming.y * controlScale };
		const control2 = { x: after.x - outgoing.x * controlScale, y: after.y - outgoing.y * controlScale };
		path += ` L ${pointText(before)} C ${pointText(control1)}, ${pointText(control2)}, ${pointText(after)}`;
	}
	path += ` L ${pointText(route[route.length - 1])}`;
	const lengths = route.slice(1).map((point, index) => Math.hypot(point.x - route[index].x, point.y - route[index].y));
	const target = lengths.reduce((sum, length) => sum + length, 0) / 2;
	let travelled = 0;
	let midpoint = route[0];
	for (let index = 0; index < lengths.length; index += 1) {
		if (travelled + lengths[index] >= target) {
			const ratio = lengths[index] ? (target - travelled) / lengths[index] : 0;
			midpoint = { x: route[index].x + (route[index + 1].x - route[index].x) * ratio, y: route[index].y + (route[index + 1].y - route[index].y) * ratio };
			break;
		}
		travelled += lengths[index];
	}
	return { path, midpoint, kind: route.length === 2 ? "straight" : route.length === 4 ? "s-bend" : "outer-gutter" };
}

function routeFlowEdges(canvas: HTMLElement): void {
	const layout = canvas.querySelector<HTMLElement>(".po-map-layout");
	const svg = layout?.querySelector<SVGSVGElement>(".po-map-edges");
	if (!layout || !svg || canvas.clientWidth < 1) return;
	const mode = flowLayoutMode(canvas);
	layout.dataset.layoutEngine = "semantic-grid";
	layout.dataset.layoutMode = mode;
	svg.removeAttribute("viewBox");
	svg.removeAttribute("width");
	svg.removeAttribute("height");
	svg.style.width = "100%";
	svg.style.height = "100%";
	void layout.offsetWidth;
	const width = Math.max(layout.clientWidth, layout.scrollWidth);
	const height = Math.max(layout.clientHeight, layout.scrollHeight);
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.style.width = `${width}px`;
	svg.style.height = `${height}px`;
	const usedSides = new Map<FlowNodeId, Set<FlowSide>>(FLOW_NODE_ORDER.map((id) => [id, new Set<FlowSide>()]));
	const nodeBounds = new Map<FlowNodeId, FlowBounds>();
	for (const id of FLOW_NODE_ORDER) {
		const bounds = flowBounds(layout, id);
		if (bounds) nodeBounds.set(id, bounds);
	}
	const obstacles = [...nodeBounds.values()].map((bounds) => inflateBounds(bounds, ROUTE_NODE_HALO));
	const portAllocations = allocateRoutePorts(mode, nodeBounds);
	const routedSegments: RouteSegment[] = [];
	for (const route of FLOW_ROUTES) {
		const fromBounds = nodeBounds.get(route.from);
		const toBounds = nodeBounds.get(route.to);
		const group = svg.querySelector<SVGGElement>(`[data-edge="${route.id}"]`);
		if (!fromBounds || !toBounds || !group) continue;
		const sides = routePortSides(route, mode);
		const fromPort = portAllocations.get(`${route.id}:from`) ?? { offset: 0, fraction: 0.5 };
		const toPort = portAllocations.get(`${route.id}:to`) ?? { offset: 0, fraction: 0.5 };
		usedSides.get(route.from)?.add(sides.from);
		usedSides.get(route.to)?.add(sides.to);
		group.dataset.fromPortFraction = fromPort.fraction.toFixed(3);
		group.dataset.toPortFraction = toPort.fraction.toFixed(3);
		const start = flowAnchor(fromBounds, sides.from, fromPort.offset);
		const end = flowAnchor(toBounds, sides.to, toPort.offset);
		const fromVector = sideVector(sides.from);
		const toVector = sideVector(sides.to);
		const leadLength = terminalLeadLength(start, end, fromVector, toVector);
		const startLead = { x: start.x + fromVector.x * leadLength, y: start.y + fromVector.y * leadLength };
		const endLead = { x: end.x + toVector.x * leadLength, y: end.y + toVector.y * leadLength };
		const portAlignedPoints = preferredPortAlignedRoute(startLead, endLead, sides, obstacles, routedSegments);
		const graph = portAlignedPoints ? undefined : buildRoutingGraph(obstacles, startLead, endLead, width, height);
		const channelPoints = portAlignedPoints ?? shortestChannelRoute(graph!, startLead, endLead, routedSegments);
		const routePoints = simplifyRoutePoints([start, ...channelPoints, end]);
		const curve = roundedChannelPath(routePoints);
		for (const path of group.querySelectorAll<SVGPathElement>("path")) path.setAttribute("d", curve.path);
		group.dataset.routing = "SEMANTIC_SPLINE";
		group.dataset.terminals = "port-aware-curved";
		group.dataset.routeKind = curve.kind;
		group.dataset.obstacleSafe = "visibility-channel";
		group.dataset.bendAlignment = portAlignedPoints ? "port-axis" : "visibility-search";
		for (let index = 1; index < routePoints.length; index += 1) routedSegments.push({ start: routePoints[index - 1], end: routePoints[index] });
		const tip = layout.querySelector<HTMLElement>(`[data-edge-tip="${route.id}"]`);
		if (tip) {
			tip.style.left = `${Math.max(4, Math.min(width - 284, curve.midpoint.x - 140))}px`;
			tip.style.top = `${Math.max(4, curve.midpoint.y - 46)}px`;
		}
	}
	for (const id of FLOW_NODE_ORDER) {
		const element = layout.querySelector<HTMLElement>(`[data-flow-node="${id}"]`);
		if (!element) continue;
		element.dataset.portSides = [...(usedSides.get(id) ?? [])].join(" ");
	}
}

function scheduleFlowRouting(state: PaneState): void {
	state.flowResizeObserver?.disconnect();
	state.flowResizeObserver = undefined;
	const canvas = state.root.querySelector<HTMLElement>(".po-map-canvas");
	if (!canvas) return;
	// Route in the same task as DOM replacement. Deferring to the next animation
	// frame paints the default wide grid first, which makes notification-driven
	// refreshes visibly flash through a different layout.
	routeFlowEdges(canvas);
	if (typeof ResizeObserver !== "undefined") {
		let observedWidth = canvas.clientWidth;
		state.flowResizeObserver = new ResizeObserver(() => {
			if (canvas.clientWidth === observedWidth) return;
			observedWidth = canvas.clientWidth;
			routeFlowEdges(canvas);
		});
		state.flowResizeObserver.observe(canvas);
	}
}

function programmeHeadline(icon: IconName, value: string, label: string, detail: string): HTMLElement {
	const item = node("div", "po-headline");
	const glyph = node("span", "po-headline-icon");
	glyph.append(lucideIcon(icon));
	const copy = node("div", "po-headline-copy");
	copy.append(node("strong", "", value), node("span", "", label));
	item.append(glyph, copy, node("small", "", detail));
	return item;
}

function renderFlow(state: PaneState): HTMLElement {
	const snapshot = state.snapshot;
	const scanner = snapshot?.scanner;
	const director = snapshot?.director;
	const coverage = snapshot?.coverage ?? [];
	const coverageUnits = flattenCoverage(coverage, "").length;
	const coverageTotals = coverage.reduce((totals, item) => ({ covered: totals.covered + (item.covered ?? 0), total: totals.total + (item.total ?? 0) }), { covered: 0, total: 0 });
	const coveragePercent = coverageTotals.total ? Math.round((coverageTotals.covered / coverageTotals.total) * 100) : undefined;
	const activeGoals = (snapshot?.goals ?? []).filter((goal) => /^(?:active|in-progress)(?:\s|·|$)/i.test(goal.detail ?? "")).length;
	const canvas = node("div", "po-map-canvas");
	const layout = node("div", "po-map-layout");
	layout.append(renderFlowEdges(), renderFlowTooltips());
	layout.append(
		flowNode("scanner", "Optimisation Scanner", "staff", { value: countValue(scanner?.activeScans), label: "active scans" }, scanner?.state, { label: "Open session", value: scanner?.sessionId ? `session:${scanner.sessionId}` : "none", disabled: !scanner?.sessionId }, hostBobbitSprite(state, "Optimisation Scanner", scanner?.state, bobbitSubject(snapshot?.scannerStaffId, scanner?.sessionId))),
		flowNode("coverage", "Coverage", "store", { value: snapshot ? String(coverageUnits) : "—", label: "mapped units" }, undefined, { label: "Inspect", value: "navigate:coverage", disabled: state.host?.capabilities?.ui !== true }),
		flowNode("ideators", "Ideators", "process", { value: countValue(scanner?.activeScans), label: "delegates" }, scanner?.state),
		flowNode("hypotheses", "Hypotheses", "store", { value: snapshot ? String(snapshot.registry.length) : "—", label: "registered" }, undefined, { label: "Browse", value: "navigate:registry", disabled: state.host?.capabilities?.ui !== true }),
		flowNode("director", "Optimisation Director", "staff", { value: countValue(director?.activeAgents), label: "active agents" }, director?.state, { label: "Open session", value: director?.sessions[0]?.sessionId ? `session:${director.sessions[0].sessionId}` : "none", disabled: !director?.sessions[0]?.sessionId }, hostBobbitSprite(state, "Optimisation Director", director?.state, bobbitSubject(snapshot?.directorStaffId, director?.sessions[0]?.sessionId))),
		flowNode("goals", "Goal teams", "process", { value: snapshot ? String(activeGoals) : "—", label: "in flight" }, activeGoals ? "active" : "idle"),
		flowNode("benchmarks", "Benchmarks", "store", { value: snapshot ? String(snapshot.benchmarks.length) : "—", label: `${snapshot?.benchmarkRuns.length ?? 0} runs` }, undefined, { label: "Browse", value: "navigate:benchmarks", disabled: state.host?.capabilities?.ui !== true }),
	);
	canvas.append(layout);
	const map = node("section", "po-map");
	const head = node("div", "po-section-head po-map-head");
	const copy = node("div");
	copy.append(node("p", "po-eyebrow", "Autonomous programme"), node("h2", "", "Performance system map"));
	head.append(copy, node("span", "po-map-legend", "Hover routes for tool calls"));
	map.append(head, canvas);
	const headlines = node("section", "po-headlines");
	headlines.setAttribute("aria-label", "Programme headline status");
	headlines.append(
		programmeHeadline("scan", coveragePercent === undefined ? "—" : `${coveragePercent}%`, "coverage current", `${coverageUnits} mapped units`),
		programmeHeadline("hypothesis", snapshot ? String(snapshot.registry.length) : "—", "open hypotheses", `${scanner?.completedLast24h ?? 0} scans today`),
		programmeHeadline("goal", snapshot ? String(activeGoals) : "—", "goals in flight", `${director?.activeAgents ?? 0} active agents`),
		programmeHeadline("activity", snapshot ? String(snapshot.benchmarkRuns.length) : "—", "benchmark runs", `${snapshot?.benchmarks.length ?? 0} registered`),
	);
	const wrapper = node("div", "po-view po-flow-view");
	wrapper.append(headlines, map, renderActivity(state));
	return wrapper;
}

function flattenCoverage(nodes: CoverageNode[], query: string, depth = 0): Array<{ item: CoverageNode; depth: number }> {
	const result: Array<{ item: CoverageNode; depth: number }> = [];
	for (const item of nodes) {
		const descendants = flattenCoverage(item.children, query, depth + 1);
		const matches = !query || `${item.label} ${item.kind ?? ""}`.toLowerCase().includes(query);
		if (matches || descendants.length) result.push({ item, depth }, ...descendants);
	}
	return result;
}

function coverageLabel(item: CoverageNode): string {
	if (item.total !== undefined && item.total > 0 && item.covered !== undefined) return `${Math.min(item.covered, item.total)}/${item.total}`;
	if (item.state === "awaiting") return "Awaiting";
	if (item.state === "stale") return "Stale";
	if (item.state === "scanned") return "Scanned";
	return "Not reported";
}

function findCoverage(nodes: CoverageNode[], id?: string): CoverageNode | undefined {
	for (const item of nodes) {
		if (item.id === id) return item;
		const nested = findCoverage(item.children, id);
		if (nested) return nested;
	}
	return undefined;
}

function renderCoverage(state: PaneState): HTMLElement {
	const wrapper = node("div", "po-view");
	const section = node("section", "po-content");
	const head = node("div", "po-section-head po-panel-head");
	const copy = node("div");
	copy.append(node("h2", "", "Scan coverage"), node("p", "po-muted", "Project → component → subsystem or module → file"));
	head.append(copy);
	section.append(head);
	const roots = state.snapshot?.coverage ?? [];
	if (!roots.length) {
		section.append(emptyState("No coverage hierarchy", "Coverage will appear after the Optimisation Scanner maps and scans production code."));
		wrapper.append(section);
		return wrapper;
	}
	const body = node("div", "po-browser");
	const sidebar = node("div", "po-browser-list");
	const search = node("input", "po-search") as HTMLInputElement;
	search.type = "search";
	search.placeholder = "Filter coverage…";
	search.setAttribute("aria-label", "Filter scan coverage");
	search.dataset.input = "coverage-query";
	search.value = state.coverageQuery;
	sidebar.append(search);
	const flattened = flattenCoverage(roots, state.coverageQuery.toLowerCase());
	if (!flattened.length) sidebar.append(emptyState("No matches", "Try another project, module, or file name."));
	for (const { item, depth } of flattened) {
		const row = button(item.label, `coverage:${item.id}`, "po-tree-row");
		row.style.setProperty("--depth", String(depth));
		row.setAttribute("aria-pressed", String(state.selectedCoverageId === item.id));
		row.append(node("span", `po-coverage-state is-${item.state ?? "unknown"}`, coverageLabel(item)));
		sidebar.append(row);
	}
	const selected = findCoverage(roots, state.selectedCoverageId) ?? flattened[0]?.item;
	if (selected && !state.selectedCoverageId) state.selectedCoverageId = selected.id;
	const detail = node("div", "po-browser-detail");
	if (!selected) detail.append(emptyState("Select a coverage node", "Choose a project, component, module, or file to inspect it."));
	else {
		detail.append(node("p", "po-eyebrow", selected.kind ?? "Coverage node"), node("h3", "", selected.label));
		const facts = node("dl", "po-facts");
		for (const [term, value] of [
			["State", selected.state ? selected.state[0].toUpperCase() + selected.state.slice(1) : "Not reported"],
			["Coverage", selected.total !== undefined && selected.total > 0 && selected.covered !== undefined ? `${Math.min(selected.covered, selected.total)} of ${selected.total}` : "Not reported"],
			["Last scan", selected.lastScan ?? "Not reported"],
			["Children", String(selected.children.length)],
		]) {
			const group = node("div");
			group.append(node("dt", "", term), node("dd", "", value));
			facts.append(group);
		}
		detail.append(facts);
		if (selected.detail) detail.append(node("p", "po-detail-copy", selected.detail));
	}
	body.append(sidebar, detail);
	section.append(body);
	wrapper.append(section);
	return wrapper;
}

function renderRegistry(state: PaneState): HTMLElement {
	const wrapper = node("div", "po-view");
	const section = node("section", "po-content");
	const head = node("div", "po-section-head po-panel-head");
	const copy = node("div");
	copy.append(node("h2", "", "Hypothesis registry"), node("p", "po-muted", "Ranked performance opportunities with linked evidence"));
	head.append(copy, node("span", "po-count", String(state.snapshot?.registry.length ?? 0)));
	section.append(head);
	const items = state.snapshot?.registry ?? [];
	if (!items.length) {
		section.append(emptyState("Registry is empty", "Evidence-backed performance hypotheses will appear after scanner findings are recorded."));
		wrapper.append(section);
		return wrapper;
	}
	const body = node("div", "po-browser");
	const list = node("div", "po-browser-list");
	const search = node("input", "po-search") as HTMLInputElement;
	search.type = "search";
	search.placeholder = "Search hypotheses…";
	search.setAttribute("aria-label", "Search hypothesis registry");
	search.dataset.input = "registry-query";
	search.value = state.registryQuery;
	list.append(search);
	const query = state.registryQuery.toLowerCase();
	const filtered = items.filter((item) => !query || `${item.title} ${item.status ?? ""} ${item.workload ?? ""} ${item.summary ?? ""}`.toLowerCase().includes(query));
	if (!filtered.length) list.append(emptyState("No matches", "Try another hypothesis, workload, or state."));
	for (const item of filtered) {
		const row = button(item.title, `hypothesis:${item.id}`, "po-hypothesis-row");
		row.setAttribute("aria-pressed", String(state.selectedHypothesisId === item.id));
		row.prepend(node("strong", "po-confidence", item.confidence === undefined ? "—" : item.confidence.toFixed(2)));
		row.append(node("span", "po-tiny", [item.workload, item.status].filter(Boolean).join(" · ") || "Details not reported"));
		list.append(row);
	}
	const selected = items.find((item) => item.id === state.selectedHypothesisId) ?? filtered[0];
	if (selected && !state.selectedHypothesisId) state.selectedHypothesisId = selected.id;
	const detail = node("div", "po-browser-detail");
	if (!selected) detail.append(emptyState("Select a hypothesis", "Choose an entry to inspect its evidence."));
	else {
		detail.append(node("p", "po-eyebrow", `${selected.id}${selected.status ? ` · ${selected.status}` : ""}`), node("h3", "", selected.title));
		if (selected.summary) detail.append(node("p", "po-detail-copy", selected.summary));
		const facts = node("dl", "po-facts");
		for (const [term, value] of [
			["Confidence", selected.confidence === undefined ? "Not reported" : selected.confidence.toFixed(2)],
			["Workload", selected.workload ?? "Not reported"],
			["Last evidence", selected.lastEvidence ?? "Not reported"],
		]) {
			const group = node("div");
			group.append(node("dt", "", term), node("dd", "", value));
			facts.append(group);
		}
		detail.append(facts);
		const evidence = node("div", "po-evidence");
		evidence.append(node("strong", "", "Evidence trail"), node("p", "", selected.evidence ?? "No evidence summary supplied."));
		detail.append(evidence);
		if (selected.sessionId) detail.append(sessionButton(state, "Open source session", selected.sessionId));
	}
	body.append(list, detail);
	section.append(body);
	wrapper.append(section);
	return wrapper;
}

function metricEntries(values: Record<string, number>, primaryMetric?: string, primaryUnit?: string): string {
	const entries = Object.entries(values);
	if (!entries.length) return "No metrics recorded";
	return entries.map(([name, value]) => `${name}: ${value.toLocaleString()}${primaryUnit && name === primaryMetric ? ` ${primaryUnit}` : ""}`).join(" · ");
}

function renderBenchmarks(state: PaneState): HTMLElement {
	const wrapper = node("div", "po-view");
	const section = node("section", "po-content po-benchmarks");
	const items = state.snapshot?.benchmarks ?? [];
	const runs = state.snapshot?.benchmarkRuns ?? [];
	const outcomes = state.snapshot?.outcomes ?? [];
	const head = node("div", "po-section-head po-panel-head");
	const copy = node("div");
	copy.append(node("p", "po-eyebrow", "Measurement catalogue"), node("h2", "", "Benchmark store"));
	head.append(copy);
	section.append(head);
	const stats = node("div", "po-stat-grid");
	for (const [iconName, value, label] of [
		["database", items.length, "registered references"],
		["activity", runs.length, "recorded runs"],
		["goal", outcomes.length, "terminal outcomes"],
	] as Array<[IconName, number, string]>) {
		const card = node("div", "po-stat-card");
		card.append(lucideIcon(iconName), metricBlock(String(value), label));
		stats.append(card);
	}
	section.append(stats);
	if (!items.length) {
		section.append(emptyState("No benchmarks registered", "Project-owned benchmark commands will appear after the programme registers measurement references."));
		wrapper.append(section);
		return wrapper;
	}
	const body = node("div", "po-browser");
	const list = node("div", "po-browser-list");
	const searchWrap = node("label", "po-search-wrap");
	searchWrap.append(lucideIcon("search"));
	const search = node("input", "po-search") as HTMLInputElement;
	search.type = "search";
	search.placeholder = "Search benchmarks…";
	search.setAttribute("aria-label", "Search benchmark store");
	search.dataset.input = "benchmark-query";
	search.value = state.benchmarkQuery;
	searchWrap.append(search);
	list.append(searchWrap);
	const query = state.benchmarkQuery.toLowerCase();
	const filtered = items.filter((item) => !query || `${item.name} ${item.component ?? ""} ${item.commandName ?? ""} ${item.metric ?? ""} ${item.tags.join(" ")}`.toLowerCase().includes(query));
	if (!filtered.length) list.append(emptyState("No matches", "Try another benchmark, component, command, metric, or tag."));
	for (const item of filtered) {
		const itemRuns = runs.filter((run) => run.benchmarkId === item.id);
		const row = button("", `benchmark:${item.id}`, "po-benchmark-row");
		row.setAttribute("aria-pressed", String(state.selectedBenchmarkId === item.id));
		const glyph = node("span", "po-list-icon");
		glyph.append(lucideIcon("database"));
		const rowCopy = node("span", "po-row-copy");
		rowCopy.append(node("strong", "", item.name), node("span", "", [item.component, item.metric && item.unit ? `${item.metric} · ${item.unit}` : item.metric].filter(Boolean).join(" · ")));
		row.append(glyph, rowCopy, node("span", "po-run-count", String(itemRuns.length)));
		list.append(row);
	}
	const selected = items.find((item) => item.id === state.selectedBenchmarkId) ?? filtered[0];
	if (selected && !state.selectedBenchmarkId) state.selectedBenchmarkId = selected.id;
	const detail = node("div", "po-browser-detail");
	if (!selected) detail.append(emptyState("Select a benchmark", "Choose a benchmark reference to inspect its configuration and runs."));
	else {
		const title = node("div", "po-detail-title");
		const titleIcon = node("span", "po-detail-icon");
		titleIcon.append(lucideIcon("database"));
		const titleCopy = node("div");
		titleCopy.append(node("p", "po-eyebrow", selected.id), node("h3", "", selected.name));
		title.append(titleIcon, titleCopy);
		detail.append(title);
		if (selected.commandName) {
			const command = node("div", "po-command");
			command.append(node("span", "", "Named command reference"), node("code", "", selected.commandName));
			detail.append(command);
		}
		const facts = node("dl", "po-facts");
		for (const [term, value] of [
			["Component", selected.component ?? "Not reported"],
			["Primary metric", [selected.metric, selected.unit].filter(Boolean).join(" · ") || "Not reported"],
			["Direction", selected.direction ? `${selected.direction} is better` : "Not reported"],
			["Protocol", `${selected.warmup ?? 0} warm-up · ${selected.repetitions ?? "—"} measured`],
		]) {
			const group = node("div");
			group.append(node("dt", "", term), node("dd", "", value));
			facts.append(group);
		}
		detail.append(facts);
		if (selected.tags.length) {
			const tags = node("div", "po-tags");
			for (const tag of selected.tags) tags.append(node("span", "", tag));
			detail.append(tags);
		}
		const selectedRuns = runs.filter((run) => run.benchmarkId === selected.id);
		const runSection = node("section", "po-run-section");
		const runHead = node("div", "po-subhead");
		runHead.append(node("h4", "", "Run history"), node("span", "po-count", String(selectedRuns.length)));
		runSection.append(runHead);
		if (!selectedRuns.length) runSection.append(emptyState("No runs recorded", "Baseline and candidate measurements will appear here."));
		for (const run of selectedRuns) {
			const runCard = node("article", `po-run-card is-${run.kind ?? "unknown"}`);
			const runTitle = node("div", "po-run-head");
			runTitle.append(node("strong", "", run.kind ? run.kind[0].toUpperCase() + run.kind.slice(1) : "Run"), node("time", "", activityTime(run.createdAt)));
			runCard.append(runTitle, node("p", "po-run-metric", metricEntries(run.metrics, selected.metric, selected.unit)));
			if (run.commit) runCard.append(node("code", "po-commit", run.commit));
			if (run.interpretation) runCard.append(node("p", "po-detail-copy", run.interpretation));
			const outcome = outcomes.find((item) => item.hypothesisId === run.hypothesisId);
			if (outcome?.outcome) runCard.append(node("span", "po-outcome", outcome.outcome));
			runSection.append(runCard);
		}
		detail.append(runSection);
	}
	body.append(list, detail);
	section.append(body);
	wrapper.append(section);
	return wrapper;
}

function styles(): HTMLStyleElement {
	const style = document.createElement("style");
	style.textContent = `
		.performance-pane { container-type: inline-size; min-height: 100%; color: var(--foreground); background: var(--background); font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
		.performance-pane, .performance-pane * { box-sizing: border-box; }
		.performance-pane button, .performance-pane input { font: inherit; }
		.po-shell { min-height: 100%; display: grid; align-content: start; }
		.po-icon { width: 15px; height: 15px; flex: 0 0 auto; }
		.po-eyebrow { margin: 0 0 4px; color: var(--muted-foreground); font-size: 9px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
		.po-muted { margin: 4px 0 0; color: var(--muted-foreground); }
		.po-button, .po-row-button, .po-feed-action, .po-map-action { min-height: 30px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 6px; color: var(--foreground); background: var(--card); cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
		.performance-pane button:not(.po-tab):hover:not(:disabled) { color: var(--foreground); border-color: color-mix(in oklch, var(--primary) 40%, var(--border)); background: color-mix(in oklch, var(--primary) 8%, var(--card)); }
		.performance-pane button:focus-visible, .performance-pane input:focus-visible, .po-edge:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
		.performance-pane button:disabled { opacity: .42; cursor: not-allowed; }
		.po-tabs { width: 100%; min-width: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: stretch; gap: .2em; margin: 0 0 2px; padding: 0 4px 4px; border-bottom: 1px solid color-mix(in oklch, var(--border) 30%, transparent); background: transparent; font-size: 12px; }
		.po-tab { width: 100%; min-width: 0; max-width: 100%; padding: 4px 6px; display: inline-flex; align-items: center; justify-content: center; gap: min(.25em, .375rem); overflow: hidden; border: 0; border-radius: 4px; color: var(--muted-foreground); background: transparent; cursor: pointer; font-size: 1.1667em; font-weight: 400; line-height: 1.25; text-align: center; transition: color 150ms ease, background-color 150ms ease; }
		.po-tab:hover { color: var(--muted-foreground); background: transparent; }
		.po-tab[aria-selected="true"]:hover { color: var(--primary); background: color-mix(in oklch, var(--primary) 10%, transparent); }
		.po-tab:active { background: color-mix(in oklch, var(--secondary) 50%, transparent); }
		.po-tab[aria-selected="true"] { color: var(--primary); background: color-mix(in oklch, var(--primary) 10%, transparent); font-weight: 500; }
		.po-tab-icon { width: 1em; height: 1em; flex: 0 0 1em; }
		.po-tab-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.po-view, .po-content { min-width: 0; }
		.po-section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
		.po-section-head h2 { margin: 0; font-size: 15px; line-height: 1.2; letter-spacing: -.015em; }
		.po-panel-head { min-height: 58px; padding: 0 0 14px; }
		.po-demo-note, .po-diagnostic { margin: 10px 14px 0; }
		.po-demo-note { color: var(--muted-foreground); font-size: 10px; }
		.po-count { padding: 3px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted-foreground); font-size: 9px; line-height: 1.2; white-space: nowrap; }
		.po-flow-view { padding: clamp(9px, 1.4cqi, 14px); display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 10px; }
		.po-headlines { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 2px solid var(--border); background: var(--card); }
		.po-headline { min-width: 0; min-height: 62px; padding: 8px 11px; display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 0 9px; border-right: 2px solid var(--border); }
		.po-headline:last-child { border-right: 0; }
		.po-headline-icon { width: 28px; height: 28px; grid-row: 1 / 3; display: grid; place-items: center; border: 2px solid var(--border); border-radius: 7px; color: var(--primary); background: color-mix(in oklch, var(--primary) 9%, var(--card)); }
		.po-headline-icon .po-icon { width: 13px; height: 13px; stroke-width: 2.5; }
		.po-headline-copy { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
		.po-headline-copy strong { font-size: 25px; font-weight: 780; line-height: 1; letter-spacing: -.05em; font-variant-numeric: tabular-nums; }
		.po-headline-copy span { color: var(--foreground); overflow: hidden; text-overflow: ellipsis; font-size: 9px; font-weight: 760; text-transform: uppercase; letter-spacing: .055em; white-space: nowrap; }
		.po-headline small { grid-column: 2; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; font-size: 9px; white-space: nowrap; }
		.po-map { min-width: 0; border: 3px solid var(--border); background: var(--card); box-shadow: 0 14px 36px color-mix(in oklch, var(--foreground) 7%, transparent); }
		.po-map-head { min-height: 56px; padding: 9px 12px; border-bottom: 3px solid var(--border); }
		.po-map-head h2 { font-size: 17px; font-weight: 800; }
		.po-map-legend { display: inline-flex; align-items: center; gap: 6px; color: var(--muted-foreground); font-size: 9px; }
		.po-map-legend::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--positive); box-shadow: 0 0 0 3px color-mix(in oklch, var(--positive) 12%, transparent); }
		.po-map-canvas { position: relative; min-width: 0; min-height: 450px; overflow: auto; isolation: isolate; background-image: linear-gradient(color-mix(in oklch, var(--border) 18%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklch, var(--border) 18%, transparent) 1px, transparent 1px), radial-gradient(circle, color-mix(in oklch, var(--primary) 35%, transparent) .65px, transparent .75px); background-size: 80px 80px, 80px 80px, 16px 16px; }
		.po-map-layout { position: relative; min-width: 860px; min-height: 450px; padding: 56px 34px 64px; display: grid; grid-template-areas: "scanner ideators director goals" "coverage hypotheses hypotheses benchmarks"; grid-template-columns: repeat(4, minmax(152px, 1fr)); grid-template-rows: repeat(2, minmax(176px, auto)); column-gap: clamp(34px, 4.2cqi, 68px); row-gap: 70px; align-items: center; }
		.po-map-layout[data-layout-mode="STORE_COLUMN"] { min-width: 100%; padding: 52px 54px 70px; grid-template-areas: "scanner coverage" "ideators hypotheses" "director ." "goals benchmarks"; grid-template-columns: repeat(2, minmax(162px, 1fr)); grid-template-rows: repeat(4, minmax(176px, auto)); column-gap: clamp(54px, 10cqi, 96px); row-gap: 48px; }
		.po-map-layout[data-layout-mode="SINGLE_COLUMN"] { min-width: 100%; padding: 52px 66px 70px; grid-template-areas: "scanner" "coverage" "ideators" "hypotheses" "director" "goals" "benchmarks"; grid-template-columns: minmax(0, 1fr); grid-template-rows: repeat(7, auto); gap: 42px; }
		.po-map-node[data-flow-node="scanner"] { grid-area: scanner; } .po-map-node[data-flow-node="coverage"] { grid-area: coverage; } .po-map-node[data-flow-node="ideators"] { grid-area: ideators; } .po-map-node[data-flow-node="hypotheses"] { grid-area: hypotheses; } .po-map-node[data-flow-node="director"] { grid-area: director; } .po-map-node[data-flow-node="goals"] { grid-area: goals; } .po-map-node[data-flow-node="benchmarks"] { grid-area: benchmarks; }
		.po-map-edges { position: absolute; left: 0; top: 0; z-index: 0; overflow: visible; color: color-mix(in oklch, var(--muted-foreground) 64%, var(--border)); }
		.po-map-edges marker path { fill: currentColor; }
		.po-edge-line { fill: none; stroke: currentColor; stroke-width: 3.25; stroke-linecap: round; opacity: .9; vector-effect: non-scaling-stroke; transition: opacity 120ms ease, stroke-width 120ms ease; }
		.po-edge-hit { fill: none; stroke: transparent; stroke-width: 15; vector-effect: non-scaling-stroke; pointer-events: stroke; }
		.po-edge { cursor: help; }
		.po-edge.is-discovery { color: color-mix(in oklch, var(--chart-1) 68%, var(--muted-foreground)); }
		.po-edge.is-ideation { color: color-mix(in oklch, var(--chart-4) 68%, var(--muted-foreground)); }
		.po-edge.is-scheduling { color: color-mix(in oklch, var(--chart-2) 68%, var(--muted-foreground)); }
		.po-edge.is-measurement { color: color-mix(in oklch, var(--chart-3) 68%, var(--muted-foreground)); }
		.po-edge:hover, .po-edge:focus { color: var(--primary); }
		.po-edge:hover .po-edge-line, .po-edge:focus .po-edge-line { opacity: 1; stroke-width: 5.25; }
		.po-edge-tooltips { position: absolute; inset: 0; z-index: 100; pointer-events: none; overflow: visible; }
		.po-edge-tip { position: absolute; z-index: 101; width: max-content; max-width: 280px; opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 100ms ease; }
		.po-edge-tip.is-visible { opacity: 1; visibility: visible; }
		.po-edge-tip-body { width: max-content; max-width: 272px; padding: 6px 8px; display: grid; gap: 3px; border: 2px solid var(--border); border-radius: 6px; color: var(--foreground); background: var(--card); box-shadow: 0 8px 22px color-mix(in oklch, var(--foreground) 18%, transparent); font: 700 9px/1.35 ui-monospace, monospace; overflow-wrap: anywhere; }
		.po-edge-tip-body code { font: inherit; }
		.po-map-node { position: relative; z-index: 2; width: 152px; min-width: 0; min-height: 124px; padding: 0; justify-self: center; border: 3px solid color-mix(in oklch, var(--chart-1) 44%, var(--border)); border-radius: 13px; background: color-mix(in oklch, var(--chart-1) 4%, var(--card)); box-shadow: 0 12px 28px color-mix(in oklch, var(--foreground) 9%, transparent); transition: border-color 140ms ease, box-shadow 140ms ease; }
		.po-map-node-content { position: relative; z-index: 2; min-height: inherit; padding: 10px; display: flex; flex-direction: column; gap: 7px; }
		.po-map-node:hover { border-color: color-mix(in oklch, var(--primary) 45%, var(--border)); box-shadow: 0 14px 30px color-mix(in oklch, var(--primary) 10%, transparent); }
		.po-map-node.is-process { border-color: color-mix(in oklch, var(--chart-3) 52%, var(--border)); border-style: dashed; background: color-mix(in oklch, var(--chart-3) 5%, var(--card)); }
		.po-map-node[data-flow-node="director"] { border-color: color-mix(in oklch, var(--chart-2) 36%, var(--border)); background: color-mix(in oklch, var(--chart-2) 3%, var(--card)); }
		.po-map-node.is-store { width: 162px; min-height: 162px; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
		.po-map-node.is-store .po-map-node-content { min-height: 162px; padding: 46px 12px 25px; }
		.po-cylinder { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; overflow: visible; color: color-mix(in oklch, var(--chart-4) 58%, var(--border)); filter: drop-shadow(0 2px 0 color-mix(in oklch, var(--foreground) 5%, transparent)); }
		.po-cylinder-body { fill: color-mix(in oklch, var(--chart-4) 5%, var(--card)); }
		.po-cylinder-cap { fill: color-mix(in oklch, var(--chart-4) 11%, var(--card)); stroke: currentColor; stroke-width: 3; vector-effect: non-scaling-stroke; }
		.po-cylinder-outline { fill: none; stroke: currentColor; stroke-width: 3; vector-effect: non-scaling-stroke; }
		.po-map-node.is-store:hover .po-cylinder { color: color-mix(in oklch, var(--primary) 45%, var(--border)); }
		.po-map-node-head { display: flex; align-items: center; gap: 9px; }
		.po-map-identity { min-width: 0; flex: 1; }
		.po-map-identity h3 { margin: 3px 0 0; font-size: 12px; font-weight: 760; line-height: 1.16; text-wrap: balance; }
		.po-map-kind { display: block; color: var(--muted-foreground); font-size: 8px; font-weight: 780; letter-spacing: .09em; text-transform: uppercase; }
		.po-map-glyph { width: 28px; height: 28px; flex: 0 0 auto; display: grid; place-items: center; border: 2px solid color-mix(in oklch, var(--chart-3) 42%, var(--border)); border-radius: 7px; color: var(--chart-3); background: color-mix(in oklch, var(--chart-3) 10%, var(--card)); }
		.po-map-glyph .po-icon { width: 13px; height: 13px; stroke-width: 2.6; }
		.is-store .po-map-glyph { color: var(--chart-4); border-color: color-mix(in oklch, var(--chart-4) 30%, var(--border)); background: color-mix(in oklch, var(--chart-4) 8%, var(--card)); }
		.po-map-metric { display: flex; align-items: baseline; gap: 7px; }
		.po-map-metric strong { font-size: 28px; font-weight: 820; line-height: 1; letter-spacing: -.055em; font-variant-numeric: tabular-nums; }
		.po-map-metric span { color: var(--muted-foreground); font-size: 8px; font-weight: 760; letter-spacing: .065em; text-transform: uppercase; }
		.po-map-action { min-height: 25px; margin-top: auto; padding: 3px 7px; align-self: flex-end; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 7px; color: var(--foreground); background: color-mix(in oklch, var(--foreground) 4%, var(--card)); font-size: 9px; font-weight: 740; }
		.po-map-action .po-icon { width: 12px; height: 12px; }
		.po-map-status { width: 9px; min-width: 9px; height: 9px; min-height: 9px; flex: 0 0 9px; padding: 0; overflow: hidden; border-radius: 50%; color: transparent !important; font-size: 0; line-height: 0; background: var(--muted-foreground); box-shadow: 0 0 0 3px color-mix(in oklch, var(--muted-foreground) 12%, transparent); }
		.po-map-status.is-active { background: var(--positive); box-shadow: 0 0 0 3px color-mix(in oklch, var(--positive) 12%, transparent); }
		.po-map-status.is-paused { background: var(--warning); box-shadow: 0 0 0 3px color-mix(in oklch, var(--warning) 12%, transparent); }
		.po-activity { min-width: 0; border: 3px solid var(--border); background: var(--card); }
		.po-activity > .po-section-head { min-height: 56px; padding: 9px 12px; border-bottom: 3px solid var(--border); }
		.po-activity > .po-section-head h2 { font-size: 17px; font-weight: 760; }
		.po-feed { max-height: 408px; overflow-y: auto; list-style: none; margin: 0; padding: 0; }
		.po-feed-row { min-height: 54px; padding: 7px 10px; display: grid; grid-template-columns: 6px minmax(0, 1fr) auto; gap: 2px 8px; align-items: center; border-bottom: 1px solid color-mix(in oklch, var(--border) 72%, transparent); }
		.po-feed-indicator { width: 5px; height: 5px; grid-row: 1 / 4; border-radius: 50%; background: var(--info); }
		.po-feed-row.is-success .po-feed-indicator { background: var(--positive); } .po-feed-row.is-warning .po-feed-indicator { background: var(--warning); } .po-feed-row.is-error .po-feed-indicator { background: var(--negative); }
		.po-feed-row time { color: var(--muted-foreground); font-size: 8px; } .po-feed-row strong { grid-column: 2; font-size: 10px; } .po-feed-message { grid-column: 2 / 4; min-width: 0; color: var(--muted-foreground); overflow-wrap: anywhere; font-size: 10px; }
		.po-feed-action, .po-feed-row .po-row-button { grid-column: 3; grid-row: 1 / 3; width: auto; min-height: 24px; padding: 3px 6px; font-size: 8px; }
		.po-feed-empty-action { grid-column: 3; grid-row: 1 / 3; color: var(--muted-foreground); }
		.po-empty { margin: 14px; padding: 24px; border: 1px dashed var(--border); border-radius: 8px; text-align: center; color: var(--muted-foreground); background: color-mix(in oklch, var(--background) 64%, transparent); }
		.po-empty strong { color: var(--foreground); } .po-empty p { margin: 5px auto 0; max-width: 55ch; }
		.po-content { padding: clamp(16px, 2.6cqi, 28px); }
		.po-browser { display: grid; grid-template-columns: minmax(260px, .75fr) minmax(360px, 1.25fr); min-height: 470px; border: 1px solid var(--border); background: var(--card); }
		.po-browser-list { min-width: 0; padding: 10px; border-right: 1px solid var(--border); overflow: auto; }
		.po-search-wrap { height: 34px; margin-bottom: 8px; padding: 0 9px; display: flex; align-items: center; gap: 7px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted-foreground); background: var(--background); }
		.po-search-wrap .po-icon { width: 14px; height: 14px; }
		.po-search { width: 100%; height: 33px; margin-bottom: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--foreground); background: var(--background); }
		.po-search-wrap .po-search { height: auto; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; }
		.po-tree-row { width: 100%; min-height: 32px; padding: 4px 7px 4px calc(7px + var(--depth) * 16px); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; border: 0; border-radius: 5px; color: var(--foreground); background: transparent; text-align: left; }
		.po-tree-row[aria-pressed="true"], .po-hypothesis-row[aria-pressed="true"], .po-benchmark-row[aria-pressed="true"] { background: color-mix(in oklch, var(--primary) 9%, var(--card)); box-shadow: inset 2px 0 var(--primary); }
		.po-coverage-state { color: var(--muted-foreground); font-size: 9px; white-space: nowrap; } .po-coverage-state.is-scanned { color: var(--positive); } .po-coverage-state.is-stale { color: var(--warning); }
		.po-browser-detail { min-width: 0; padding: clamp(16px, 2.5cqi, 24px); overflow: auto; }
		.po-browser-detail h3 { margin: 0; font-size: 19px; line-height: 1.2; letter-spacing: -.02em; }
		.po-detail-copy { color: var(--muted-foreground); overflow-wrap: anywhere; }
		.po-detail-title { display: flex; align-items: center; gap: 11px; }
		.po-detail-icon { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 7px; color: var(--chart-4); background: color-mix(in oklch, var(--chart-4) 8%, var(--card)); }
		.po-facts { margin: 16px 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
		.po-facts > div { min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--background); }
		.po-facts dt { color: var(--muted-foreground); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; } .po-facts dd { margin: 3px 0 0; overflow-wrap: anywhere; font-weight: 650; }
		.po-hypothesis-row { width: 100%; min-height: 61px; padding: 8px; display: grid; grid-template-columns: 43px minmax(0, 1fr); gap: 2px 8px; align-items: center; border: 0; border-bottom: 1px solid var(--border); border-radius: 5px; color: var(--foreground); background: transparent; text-align: left; }
		.po-hypothesis-row .po-confidence { grid-row: 1 / 3; color: var(--chart-4); font-size: 15px; } .po-hypothesis-row .po-tiny { color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; }
		.po-evidence { margin-bottom: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--background); } .po-evidence p { margin: 6px 0 0; color: var(--muted-foreground); overflow-wrap: anywhere; }
		.po-stat-grid { margin-bottom: 14px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
		.po-stat-card { min-width: 0; padding: 12px; display: flex; align-items: center; gap: 11px; border: 1px solid var(--border); background: var(--card); }
		.po-stat-card > .po-icon { width: 18px; height: 18px; color: var(--chart-4); }
		.po-benchmark-row { width: 100%; min-height: 58px; padding: 7px 8px; display: grid; grid-template-columns: 29px minmax(0, 1fr) auto; align-items: center; gap: 8px; border: 0; border-bottom: 1px solid color-mix(in oklch, var(--border) 76%, transparent); border-radius: 5px; color: var(--foreground); background: transparent; text-align: left; }
		.po-list-icon { width: 27px; height: 27px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 5px; color: var(--chart-4); }
		.po-row-copy { min-width: 0; display: grid; gap: 2px; } .po-row-copy strong, .po-row-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .po-row-copy span { color: var(--muted-foreground); font-size: 9px; }
		.po-run-count { min-width: 22px; padding: 2px 5px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted-foreground); font-size: 9px; text-align: center; }
		.po-command { margin-top: 18px; padding: 10px 12px; display: grid; gap: 4px; border-left: 2px solid var(--chart-4); background: color-mix(in oklch, var(--chart-4) 6%, var(--background)); }
		.po-command span { color: var(--muted-foreground); font-size: 8px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; } .po-command code { overflow-wrap: anywhere; font-size: 11px; }
		.po-tags { display: flex; flex-wrap: wrap; gap: 5px; } .po-tags span, .po-outcome { padding: 3px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted-foreground); background: var(--background); font-size: 9px; }
		.po-run-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
		.po-subhead, .po-run-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
		.po-subhead h4 { margin: 0; font-size: 11px; }
		.po-run-card { margin-top: 8px; padding: 11px; border: 1px solid var(--border); border-left: 2px solid var(--info); background: var(--background); }
		.po-run-card.is-candidate { border-left-color: var(--positive); } .po-run-card.is-baseline { border-left-color: var(--chart-2); }
		.po-run-head time { color: var(--muted-foreground); font-size: 8px; } .po-run-metric { margin: 7px 0; font-weight: 650; } .po-commit { color: var(--muted-foreground); font-size: 9px; } .po-outcome { display: inline-flex; margin-top: 7px; color: var(--positive); border-color: color-mix(in oklch, var(--positive) 35%, var(--border)); }
		.po-diagnostic { padding: 9px 11px; border: 1px solid var(--warning); border-radius: 6px; color: var(--warning); background: color-mix(in oklch, var(--warning) 8%, transparent); }
		.po-feed { max-height: 270px; }
		@container (max-width: 820px) {
			.po-headlines { grid-template-columns: repeat(2, minmax(0, 1fr)); } .po-headline:nth-child(2) { border-right: 0; } .po-headline:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
			.po-map-layout[data-layout-mode="STORE_COLUMN"] { padding-inline: 46px; }
		}
		@container (max-width: 650px) { .po-browser { grid-template-columns: 1fr; } .po-browser-list { max-height: 330px; border-right: 0; border-bottom: 1px solid var(--border); } .po-stat-grid { grid-template-columns: 1fr; } }
		@container (max-width: 500px) {
			.po-headlines { grid-template-columns: 1fr; } .po-headline { border-right: 0; border-bottom: 1px solid var(--border); } .po-headline:last-child { border-bottom: 0; }
			.po-facts { grid-template-columns: 1fr; }
			.po-map-layout[data-layout-mode="SINGLE_COLUMN"] { padding-inline: 42px; }
		}
	`;
	return style;
}

function renderPane(state: PaneState): void {
	const shell = node("div", "po-shell");
	shell.append(renderTabs(state));
	if (state.demo) shell.append(node("p", "po-demo-note", "Development fixture · not live project data"));
	if (state.storeState === "error" && !state.demo) shell.append(node("p", "po-diagnostic", `Live data refresh failed${state.storeDiagnostic ? ` (${state.storeDiagnostic})` : ""}. Existing data was not replaced.`));
	const view = state.tab === "coverage" ? renderCoverage(state) : state.tab === "registry" ? renderRegistry(state) : state.tab === "benchmarks" ? renderBenchmarks(state) : renderFlow(state);
	view.id = `po-view-${state.tab}`;
	view.setAttribute("role", "tabpanel");
	view.setAttribute("aria-labelledby", `po-tab-${state.tab}`);
	shell.append(view);
	// Reuse the parsed stylesheet. Recreating this large static style element on
	// every notification forces the browser to parse the same CSS again.
	state.root.replaceChildren(state.styleElement, shell);
	scheduleFlowRouting(state);
}

async function readStoredValue<T>(state: PaneState, key: string): Promise<{ state: "absent" } | { state: "present"; value: T } | { state: "error"; diagnostic?: string }> {
	const host = state.host;
	if (host?.capabilities?.store !== true || !host.store) return { state: "error", diagnostic: "capability-unavailable" };
	try {
		if (host.store.read) {
			const result = await host.store.read<T>(key);
			if (result.state === "present") return result;
			if (result.state === "error") return { state: "error", diagnostic: result.diagnostic?.code };
			return { state: "absent" };
		}
		const value = await host.store.get?.<T>(key);
		return value == null ? { state: "absent" } : { state: "present", value };
	} catch {
		return { state: "error", diagnostic: "request-failed" };
	}
}

function diagnosticCode(error: unknown): string {
	if (isObject(error)) return asText(error.code ?? error.routeError ?? error.message, 120) ?? "request-failed";
	return error instanceof Error ? error.message.slice(0, 120) : "request-failed";
}

function scheduleRefresh(state: PaneState, delay = 80): void {
	if (state.demo || state.refreshTimer !== undefined) return;
	state.refreshTimer = window.setTimeout(() => {
		state.refreshTimer = undefined;
		void refreshSnapshot(state);
	}, delay);
}

async function refreshSnapshot(state: PaneState): Promise<void> {
	if (state.demo) {
		state.snapshot = DEMO_SNAPSHOT;
		state.storeState = "ready";
		state.loading = false;
		renderPane(state);
		return;
	}
	if (state.refreshInFlight) {
		state.refreshPending = true;
		return;
	}
	const host = state.host;
	const canReadRoute = host?.capabilities?.callRoute === true;
	const projectSnapshot = host?.project?.snapshot;
	const canReadProject = host?.capabilities?.projectSnapshot === true && typeof projectSnapshot === "function";
	if (!canReadRoute && !canReadProject) {
		state.storeState = "unavailable";
		state.loading = false;
		renderPane(state);
		return;
	}
	const generation = ++state.refreshGeneration;
	state.refreshInFlight = true;
	state.loading = true;
	// Keep the current, fully-routed view mounted while fresh data is in flight.
	// Rendering here and again on completion needlessly replaces the whole map.
	try {
		const [routeRead, projectRead] = await Promise.all([
			canReadRoute
				? host.callRoute<unknown>(SNAPSHOT_ROUTE, {
					method: "GET",
					query: { view: state.tab, activityLimit: 50 },
				}).then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }))
				: Promise.resolve({ ok: false as const, unavailable: true as const }),
			canReadProject
				? projectSnapshot!().then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }))
				: Promise.resolve({ ok: false as const, unavailable: true as const }),
		]);
		if (generation !== state.refreshGeneration || host !== state.host || state.demo) return;

		if (routeRead.ok) {
			const normalizedRouteValue = unwrapRouteResult(routeRead.value);
			const routeError = isObject(normalizedRouteValue) && normalizedRouteValue.ok === false ? normalizedRouteValue.error : undefined;
			const parsed = routeError === undefined ? parseSnapshot(normalizedRouteValue) : null;
			if (parsed) {
				state.routeSnapshot = parsed;
				state.storeState = "ready";
				state.storeDiagnostic = undefined;
			} else {
				state.storeState = "error";
				state.storeDiagnostic = routeError === undefined ? "unsupported-snapshot" : diagnosticCode(routeError);
			}
		} else if ("error" in routeRead) {
			state.storeState = "error";
			state.storeDiagnostic = diagnosticCode(routeRead.error);
		} else {
			state.storeState = projectRead.ok ? "absent" : "unavailable";
			state.storeDiagnostic = undefined;
		}

		if (projectRead.ok) state.snapshot = mergeProjectSnapshot(state.routeSnapshot, projectRead.value);
		else state.snapshot = state.routeSnapshot;
	} finally {
		if (generation === state.refreshGeneration) {
			state.refreshInFlight = false;
			state.loading = false;
			renderPane(state);
			if (state.refreshPending) {
				state.refreshPending = false;
				// One trailing debounced read captures the latest state without spinning
				// fresh route workers back-to-back while project events are still arriving.
				scheduleRefresh(state);
			}
		}
	}
}

async function persistTab(state: PaneState): Promise<void> {
	if (state.demo || state.host?.capabilities?.store !== true || !state.host.store?.put) return;
	try {
		await state.host.store.put<UiPreferences>(UI_KEY, { version: 1, tab: state.tab });
	} catch {
		// Preferences are best-effort and never replace measured programme data.
	}
}

const PROJECT_REFRESH_EVENTS = [
	"sessionCreated", "sessionArchived", "sessionStatusChanged",
	"staffCreated", "staffConfigChanged", "staffRetired", "staffSessionChanged",
	"goalCreated", "goalUpdated", "goalCompleted", "goalArchived",
	"taskCreated", "taskUpdated", "taskStateChanged", "gateStatusChanged", "pullRequestStatusChanged",
] as const;

function observeHost(state: PaneState): void {
	const host = state.host;
	if (state.subscribedHost === host) return;
	state.sessionUnsubscribe?.();
	state.sessionUnsubscribe = undefined;
	for (const unsubscribe of state.projectUnsubscribes.splice(0)) unsubscribe();
	state.projectRefreshSubscribed = false;
	if (state.refreshTimer !== undefined) window.clearTimeout(state.refreshTimer);
	state.refreshTimer = undefined;
	state.subscribedHost = host;
	if (!host) return;

	if (host.capabilities.projectNotifications === true) {
		try {
			for (const eventName of PROJECT_REFRESH_EVENTS) {
				state.projectUnsubscribes.push(host.project.notifications.subscribe(eventName, () => scheduleRefresh(state)));
			}
			state.projectUnsubscribes.push(host.project.notifications.onRefreshRequired(() => scheduleRefresh(state, 0)));
			state.projectRefreshSubscribed = true;
		} catch {
			for (const unsubscribe of state.projectUnsubscribes.splice(0)) unsubscribe();
			state.projectRefreshSubscribed = false;
		}
	}

	// Older hosts may expose only the current-session stream. Settling is a useful
	// fallback refresh signal; authoritative activity still comes from SQLite.
	if (host.capabilities.session === true && host.capabilities.projectNotifications !== true) {
		try {
			state.sessionUnsubscribe = host.session.subscribe("status", (payload) => {
				if (payload.status === "idle" || payload.status === "error") scheduleRefresh(state);
			});
		} catch {
			state.sessionUnsubscribe = undefined;
		}
	}
}

async function initialize(state: PaneState, requestedTab?: TabId): Promise<void> {
	state.initialized = true;
	observeHost(state);
	if (!requestedTab && !state.demo && state.host?.capabilities?.store === true) {
		const result = await readStoredValue<unknown>(state, UI_KEY);
		if (result.state === "present" && isObject(result.value) && result.value.version === 1) state.tab = parseTab(result.value.tab) ?? state.tab;
	}
	// onRefreshRequired registration performs the authoritative initial refresh.
	// Do not issue a second route worker + project snapshot in parallel with it.
	if (state.demo || !state.projectRefreshSubscribed) await refreshSnapshot(state);
}

function switchTab(state: PaneState, tab: TabId): void {
	state.tab = tab;
	// Keep the structured route aligned with the local selection. Do not update
	// routeTab here: it tracks the last params actually delivered by the host, so
	// an intervening rerender with stale params cannot undo this local choice.
	renderPane(state);
	void persistTab(state);
	if (state.host?.capabilities?.ui === true && state.host.ui) {
		state.host.ui.navigate({ route: ROUTE_ID, params: { tab, ...(state.demo ? { demo: "true" } : {}) } });
	} else {
		scheduleRefresh(state);
	}
}

function handleAction(state: PaneState, action: string): void {
	if (action.startsWith("tab:")) {
		const tab = parseTab(action.slice(4));
		if (tab) switchTab(state, tab);
		return;
	}
	if (action.startsWith("navigate:")) {
		const tab = parseTab(action.slice(9));
		if (!tab || state.host?.capabilities?.ui !== true || !state.host.ui) return;
		state.tab = tab;
		void persistTab(state);
		state.host.ui.navigate({ route: ROUTE_ID, params: { tab, ...(state.demo ? { demo: "true" } : {}) } });
		return;
	}
	if (action.startsWith("session:")) {
		const sessionId = asText(action.slice(8), 100);
		if (!sessionId || state.host?.capabilities?.ui !== true || !state.host.ui || (state.host.contractVersion ?? 1) < 2) return;
		state.host.ui.openPanel({ panelId: PANEL_ID, params: { tab: state.tab }, sessionId });
		return;
	}
	if (action.startsWith("coverage:")) {
		state.selectedCoverageId = action.slice(9);
		renderPane(state);
		return;
	}
	if (action.startsWith("hypothesis:")) {
		state.selectedHypothesisId = action.slice(11);
		renderPane(state);
		return;
	}
	if (action.startsWith("benchmark:")) {
		state.selectedBenchmarkId = action.slice(10);
		renderPane(state);
	}
}

export default function createPerformancePanel() {
	const root = node("div", "performance-pane");
	root.dataset.testid = "performance-optimisation-panel";
	const state: PaneState = {
		root,
		styleElement: styles(),
		tab: "flow",
		snapshot: null,
		routeSnapshot: null,
		loading: true,
		storeState: "unknown",
		initialized: false,
		demo: false,
		liveEvents: [],
		coverageQuery: "",
		registryQuery: "",
		benchmarkQuery: "",
		projectUnsubscribes: [],
		projectRefreshSubscribed: false,
		refreshInFlight: false,
		refreshPending: false,
		refreshGeneration: 0,
		routeParamsApplied: false,
	};
	root.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-action]") : null;
		if (!target || target.disabled) return;
		handleAction(state, target.dataset.action ?? "");
	});
	root.addEventListener("input", (event) => {
		const target = event.target instanceof HTMLInputElement ? event.target : null;
		if (!target?.dataset.input) return;
		if (target.dataset.input === "coverage-query") state.coverageQuery = target.value;
		if (target.dataset.input === "registry-query") state.registryQuery = target.value;
		if (target.dataset.input === "benchmark-query") state.benchmarkQuery = target.value;
		renderPane(state);
		const replacement = state.root.querySelector<HTMLInputElement>(`input[data-input="${target.dataset.input}"]`);
		replacement?.focus();
		replacement?.setSelectionRange(target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length);
	});

	return {
		render(params: Record<string, unknown> | undefined, host: HostApi | undefined) {
			// The host creates a fresh facade object on every parent app render. Treat
			// facades for the same bound session and contract as one logical host;
			// otherwise every unrelated app render would unsubscribe, spawn a route
			// worker, open SQLite, fetch a full project snapshot, and rebuild the DOM.
			const boundSessionId = asText(params?.__sessionId, 120);
			const incomingBindingKey = host && boundSessionId
				? `${boundSessionId}:${host.contractVersion ?? host.version ?? 1}`
				: undefined;
			const hostChanged = incomingBindingKey !== undefined
				? state.hostBindingKey !== incomingBindingKey
				: state.host !== host;
			if (hostChanged) {
				state.host = host;
				state.hostBindingKey = incomingBindingKey;
			}
			if (hostChanged && state.initialized) {
				state.refreshGeneration += 1;
				state.refreshInFlight = false;
				state.refreshPending = false;
			}
			const previousTab = state.tab;
			const requestedTab = parseTab(params?.tab);
			// Route params express navigation intent, not live-data state. The host may
			// call render repeatedly with the same params while notifications refresh
			// the panel. Reapplying that stale tab on every render would override a tab
			// the user selected locally and make every data sync jump views.
			const routeTabChanged = !state.routeParamsApplied || requestedTab !== state.routeTab;
			if (routeTabChanged) {
				state.routeParamsApplied = true;
				state.routeTab = requestedTab;
				if (requestedTab) state.tab = requestedTab;
			}
			const demo = params?.demo === true || params?.demo === "true";
			const demoChanged = demo !== state.demo;
			state.demo = demo;
			observeHost(state);
			if (!state.initialized) {
				renderPane(state);
				void initialize(state, requestedTab);
			} else if (demoChanged) {
				state.snapshot = demo ? DEMO_SNAPSHOT : null;
				void refreshSnapshot(state);
			} else if (hostChanged) {
				// A newly bound notification stream schedules its own snapshot-first
				// refresh. Fall back to a direct read only on older hosts.
				if (!state.projectRefreshSubscribed) void refreshSnapshot(state);
			} else if (previousTab !== state.tab) {
				// The route returns a complete snapshot for every tab, so navigation only
				// changes presentation. Do not refetch or rebuild on unrelated app renders.
				renderPane(state);
			}
			return root;
		},
	};
}

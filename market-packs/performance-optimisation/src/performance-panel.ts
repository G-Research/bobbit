import {
	BODY_GRID,
	BODY_HEIGHT,
	BODY_WIDTH,
	EYE_POSITIONS,
	type PaletteKey,
} from "../../../src/shared/bobbit-sprite-data.ts";
import type { HostApi, HostProjectSnapshot } from "../../../src/shared/extension-host/host-api.ts";

type TabId = "flow" | "coverage" | "registry";
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

type PerformanceSnapshot = {
	version: 1;
	updatedAt?: string;
	projectName?: string;
	projectGeneratedAt?: number;
	scanner?: ScannerSnapshot;
	registry: Hypothesis[];
	director?: { state?: OperationalState; activeAgents?: number; detail?: string; sessions: SessionSummary[] };
	goals: WorkItem[];
	pullRequests: WorkItem[];
	activity: FeedEvent[];
	coverage: CoverageNode[];
};

type UiPreferences = { version: 1; tab: TabId };

type PaneState = {
	root: HTMLElement;
	host?: HostApi;
	tab: TabId;
	snapshot: PerformanceSnapshot | null;
	loading: boolean;
	storeState: "unknown" | "ready" | "absent" | "unavailable" | "error";
	storeDiagnostic?: string;
	initialized: boolean;
	demo: boolean;
	liveEvents: FeedEvent[];
	coverageQuery: string;
	registryQuery: string;
	selectedCoverageId?: string;
	selectedHypothesisId?: string;
	unsubscribe?: () => void;
};

const PANEL_ID = "performance-optimisation.panel";
const ROUTE_ID = "performance-optimisation";
const SNAPSHOT_KEY = "control-pane.snapshot";
const UI_KEY = "control-pane.ui";
const TABS: Array<{ id: TabId; label: string }> = [
	{ id: "flow", label: "Flow map" },
	{ id: "coverage", label: "Scan coverage" },
	{ id: "registry", label: "Hypothesis registry" },
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
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
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
		const label = asText(item.label ?? item.title ?? item.name, 160);
		if (!label) return [];
		return [{
			id: asText(item.id, 100) ?? `${prefix}-${index}`,
			label,
			detail: asText(item.detail ?? item.status, 160),
			sessionId: asText(item.sessionId, 100),
		}];
	});
}

function parseHypotheses(value: unknown): Hypothesis[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.items) ? value.items : [];
	return source.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const title = asText(item.title ?? item.name, 180);
		if (!title) return [];
		return [{
			id: asText(item.id, 100) ?? `hypothesis-${index}`,
			title,
			status: asText(item.status, 60),
			confidence: asConfidence(item.confidence),
			workload: asText(item.workload ?? item.kind, 100),
			summary: asText(item.summary, 500),
			evidence: asText(item.evidence ?? item.detail, 800),
			lastEvidence: asText(item.lastEvidence, 100),
			sessionId: asText(item.sessionId, 100),
		}];
	});
}

function parseCoverageNodes(value: unknown, depth = 0, prefix = "coverage"): CoverageNode[] {
	const source = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.roots) ? value.roots : [];
	if (depth > 6) return [];
	return source.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const label = asText(item.label ?? item.name, 180);
		if (!label) return [];
		const id = asText(item.id, 100) ?? `${prefix}-${index}`;
		return [{
			id,
			label,
			kind: asText(item.kind, 60),
			state: asCoverageState(item.state ?? item.status),
			covered: asCount(item.covered),
			total: asCount(item.total),
			lastScan: asText(item.lastScan, 100),
			detail: asText(item.detail, 500),
			children: parseCoverageNodes(item.children, depth + 1, id),
		}];
	});
}

function parseActivity(value: unknown): FeedEvent[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 100).flatMap((item, index) => {
		if (!isObject(item)) return [];
		const message = asText(item.message ?? item.event, 500);
		if (!message) return [];
		const kind = typeof item.kind === "string" && FEED_KINDS.has(item.kind as FeedKind) ? item.kind as FeedKind : "info";
		return [{
			id: asText(item.id, 100) ?? `activity-${index}`,
			at: asText(item.at, 100),
			kind,
			actor: asText(item.actor ?? item.source, 100) ?? "Performance system",
			message,
			tab: parseTab(item.tab),
			sessionId: asText(item.sessionId, 100),
		}];
	});
}

function parseSnapshot(value: unknown): PerformanceSnapshot | null {
	if (!isObject(value) || value.version !== 1) return null;
	const directorValue = isObject(value.director) ? value.director : undefined;
	return {
		version: 1,
		updatedAt: asText(value.updatedAt, 100),
		scanner: parseScanner(value.scanner),
		registry: parseHypotheses(value.registry ?? value.hypotheses),
		director: directorValue ? {
			state: asOperationalState(directorValue.state ?? directorValue.operationalState),
			activeAgents: asCount(directorValue.activeAgents),
			detail: asText(directorValue.detail, 240),
			sessions: parseSessions(directorValue.sessions),
		} : undefined,
		goals: parseWorkItems(value.goals, "goal"),
		pullRequests: parseWorkItems(value.pullRequests ?? value.prs, "pr"),
		activity: parseActivity(value.activity ?? value.activityFeed ?? value.feed),
		coverage: parseCoverageNodes(value.coverage),
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
	const scannerStaff = project.staff.find((staff) => staff.roleId === "performance-scanner");
	const directorStaff = project.staff.find((staff) => staff.roleId === "optimisation-director");
	const scannerSessions = staffSessions(project, scannerStaff?.id, scannerStaff?.currentSessionId);
	const directorSessions = staffSessions(project, directorStaff?.id, directorStaff?.currentSessionId);
	const scannerCurrent = project.sessions.find((session) => session.id === scannerStaff?.currentSessionId) ?? scannerSessions[0];
	const directorCurrent = project.sessions.find((session) => session.id === directorStaff?.currentSessionId) ?? directorSessions[0];

	const linkedGoalIds = new Set(stored?.goals.map((goal) => goal.id) ?? []);
	for (const session of directorSessions) if (session.goalId) linkedGoalIds.add(session.goalId);
	const linkedGoals = project.goals.filter((goal) => linkedGoalIds.has(goal.id));
	const goals = linkedGoals.map((goal): WorkItem => ({
		id: goal.id,
		label: goal.title,
		detail: goal.paused ? "paused" : goal.state,
		sessionId: project.sessions.find((session) => session.goalId === goal.id)?.id,
	}));
	for (const goal of stored?.goals ?? []) if (!goals.some((item) => item.id === goal.id)) goals.push(goal);

	const pullRequests = project.pullRequests
		.filter((pr) => linkedGoalIds.has(pr.goalId))
		.map((pr): WorkItem => ({
			id: pr.number ? `pr-${pr.number}` : `pr-${pr.goalId}`,
			label: `${pr.number ? `#${pr.number} ` : ""}${pr.title ?? "Pull request"}`,
			detail: pr.reviewDecision ?? pr.state,
		}));
	for (const pr of stored?.pullRequests ?? []) if (!pullRequests.some((item) => item.id === pr.id)) pullRequests.push(pr);

	return {
		version: 1,
		updatedAt: stored?.updatedAt,
		projectName: project.project.name,
		projectGeneratedAt: project.generatedAt,
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
			sessions: directorSessions.slice(0, 20).map((session) => ({
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
	};
}

const DEMO_SNAPSHOT: PerformanceSnapshot = {
	version: 1,
	updatedAt: "Development fixture",
	scanner: { state: "active", activeScans: 2, completedLast24h: 17, activity: "2 delegate scans running" },
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
			{ id: "director", label: "Noah · Director", detail: "Coordinating proof" },
			{ id: "benchmark", label: "Lin · Benchmark", detail: "Running A/B benchmark" },
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
		{ id: "a-3", at: "2025-01-01T11:58:00Z", kind: "info", actor: "Performance Scanner", message: "Completed scan of DB Layer", tab: "coverage" },
		{ id: "a-4", at: "2025-01-01T11:57:00Z", kind: "info", actor: "Performance Scanner", message: "Filed hypothesis “DB Layer N² lookup”", tab: "registry" },
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

function canonicalSprite(): HTMLElement {
	const sprite = node("div", "po-sprite");
	sprite.setAttribute("role", "img");
	sprite.setAttribute("aria-label", "Bobbit avatar for Performance Scanner");
	for (let y = 0; y < BODY_HEIGHT; y += 1) {
		for (let x = 0; x < BODY_WIDTH; x += 1) {
			const key = BODY_GRID[y]?.[x] as PaletteKey | undefined;
			if (!key || key === "_") continue;
			const pixel = node("span", `po-pixel pixel-${key.toLowerCase()}`);
			pixel.style.left = `${x * (100 / BODY_WIDTH)}%`;
			pixel.style.top = `${y * (100 / BODY_HEIGHT)}%`;
			sprite.append(pixel);
		}
	}
	const eyes = EYE_POSITIONS.center;
	for (const [x, y] of [[eyes.lx, eyes.ly], [eyes.lx, eyes.ly + 1], [eyes.rx, eyes.ry], [eyes.rx, eyes.ry + 1]]) {
		const eye = node("span", "po-pixel pixel-eye");
		eye.style.left = `${x * (100 / BODY_WIDTH)}%`;
		eye.style.top = `${y * (100 / BODY_HEIGHT)}%`;
		sprite.append(eye);
	}
	return sprite;
}

function emptyState(title: string, detail: string): HTMLElement {
	const wrapper = node("div", "po-empty");
	wrapper.append(node("strong", "", title), node("p", "", detail));
	return wrapper;
}

function stateBadge(value?: OperationalState): HTMLElement {
	const label = value ? value[0].toUpperCase() + value.slice(1) : "Not reported";
	return node("span", `po-state ${value ? `is-${value}` : "is-unknown"}`, label);
}

function countValue(value?: number): string {
	return value === undefined ? "—" : String(value);
}

function sessionButton(state: PaneState, label: string, sessionId?: string): HTMLButtonElement {
	const action = sessionId ? `session:${sessionId}` : "none";
	const result = button(label, action, "po-row-button");
	result.disabled = !sessionId || state.host?.capabilities?.ui !== true || (state.host.contractVersion ?? 1) < 2;
	if (!sessionId) result.title = "No session is linked in the stored snapshot";
	else if ((state.host?.contractVersion ?? 1) < 2) result.title = "This host cannot switch to linked sessions";
	return result;
}

function renderHeader(state: PaneState): HTMLElement {
	const header = node("header", "po-header");
	const copy = node("div");
	copy.append(node("p", "po-eyebrow", "Performance optimisation"));
	let subtitle = "Loading live project and pack state";
	if (state.demo) subtitle = "Development fixture · not live project data";
	else if (state.snapshot?.projectName) subtitle = `${state.snapshot.projectName} · live project state`;
	else if (state.snapshot?.updatedAt) subtitle = `Store snapshot updated ${state.snapshot.updatedAt}`;
	else if (state.storeState === "absent") subtitle = "No performance snapshot has been published";
	else if (state.storeState === "unavailable") subtitle = "Live project and pack state are unavailable on this host";
	else if (state.storeState === "error") subtitle = "The stored snapshot could not be read";
	copy.append(node("p", "po-subtitle", subtitle));
	const refresh = button(state.loading ? "Refreshing…" : "Refresh", "refresh");
	refresh.disabled = state.loading || state.demo || (state.host?.capabilities?.store !== true && state.host?.capabilities?.projectSnapshot !== true);
	header.append(copy, refresh);
	return header;
}

function renderTabs(state: PaneState): HTMLElement {
	const nav = node("nav", "po-tabs");
	nav.setAttribute("aria-label", "Performance views");
	nav.setAttribute("role", "tablist");
	for (const tab of TABS) {
		const tabButton = button(tab.label, `tab:${tab.id}`, "po-tab");
		tabButton.id = `po-tab-${tab.id}`;
		tabButton.setAttribute("role", "tab");
		tabButton.setAttribute("aria-controls", `po-view-${tab.id}`);
		tabButton.setAttribute("aria-selected", String(state.tab === tab.id));
		tabButton.tabIndex = state.tab === tab.id ? 0 : -1;
		nav.append(tabButton);
	}
	return nav;
}

function nodeHeader(title: string, kicker: string, stateValue?: OperationalState, sprite = false): HTMLElement {
	const head = node("div", "po-node-head");
	const icon = sprite ? canonicalSprite() : node("span", "po-node-icon", title === "Hypothesis Registry" ? "H" : title === "Optimisation Director" ? "O" : title === "Goals" ? "G" : "PR");
	const copy = node("div", "po-node-title");
	copy.append(node("h3", "", title), node("p", "", kicker));
	head.append(icon, copy);
	if (stateValue !== undefined || sprite || title === "Optimisation Director") head.append(stateBadge(stateValue));
	return head;
}

function miniItems(items: WorkItem[], empty: string, state: PaneState): HTMLElement {
	const list = node("div", "po-mini-list");
	if (!items.length) {
		list.append(node("p", "po-node-empty", empty));
		return list;
	}
	for (const item of items.slice(0, 2)) {
		if (item.sessionId) {
			const row = sessionButton(state, item.label, item.sessionId);
			if (item.detail) row.append(node("span", "po-tiny", item.detail));
			list.append(row);
		} else {
			const row = node("div", "po-mini-row");
			row.append(node("span", "", item.label));
			if (item.detail) row.append(node("span", "po-tiny", item.detail));
			list.append(row);
		}
	}
	return list;
}

function renderScanner(state: PaneState): HTMLElement {
	const scanner = state.snapshot?.scanner;
	const article = node("article", "po-node po-scanner");
	article.append(nodeHeader("Performance Scanner", "Scheduled discovery", scanner?.state, true));
	const metrics = node("div", "po-scanner-metrics");
	for (const metric of [
		{ value: scanner?.activeScans, label: "Live active scans" },
		{ value: scanner?.completedLast24h, label: "Completed scans · last 24h" },
	]) {
		const item = node("div", "po-scanner-metric");
		item.append(node("strong", "", countValue(metric.value)), node("span", "", metric.label));
		metrics.append(item);
	}
	article.append(metrics);
	const activity = node("p", "po-node-activity");
	if (scanner?.state === "idle" || scanner?.state === "paused") {
		activity.append(node("strong", "", "Last activity"), document.createTextNode(` · ${scanner.lastActivity ?? "not reported"}`));
	} else if (scanner?.state === "active") {
		activity.append(node("strong", "", "Working now"), document.createTextNode(` · ${scanner.activity ?? "activity detail not reported"}`));
	} else {
		activity.textContent = "Operational state has not been reported.";
	}
	article.append(activity, sessionButton(state, "Open staff session", scanner?.sessionId));
	const coverage = button("Scan coverage →", "navigate:coverage", "po-node-link");
	coverage.disabled = state.host?.capabilities?.ui !== true;
	article.append(coverage);
	return article;
}

function renderRegistryNode(state: PaneState): HTMLElement {
	const items = state.snapshot?.registry ?? [];
	const article = node("article", "po-node po-registry-node");
	article.append(nodeHeader("Hypothesis Registry", "Evidence store"));
	const metric = node("div", "po-node-metric");
	metric.append(node("strong", "", state.snapshot ? String(items.length) : "—"), node("span", "", "ranked hypotheses"));
	article.append(metric);
	if (items.length) {
		const list = node("div", "po-mini-list");
		for (const item of items.slice(0, 2)) {
			const row = node("div", "po-mini-row");
			row.append(node("span", "", item.title), node("span", "po-tiny", item.confidence === undefined ? (item.status ?? "Unreported") : item.confidence.toFixed(2)));
			list.append(row);
		}
		article.append(list);
	} else article.append(node("p", "po-node-empty", "No hypotheses published"));
	const browse = button("Browse registry →", "navigate:registry", "po-node-link");
	browse.disabled = state.host?.capabilities?.ui !== true;
	article.append(browse);
	return article;
}

function renderDirector(state: PaneState): HTMLElement {
	const director = state.snapshot?.director;
	const article = node("article", "po-node po-director");
	article.append(nodeHeader("Optimisation Director", "Plans + guardrails", director?.state));
	const metric = node("div", "po-node-metric");
	metric.append(node("strong", "", countValue(director?.activeAgents)), node("span", "", "active agents"));
	article.append(metric);
	if (director?.detail) article.append(node("p", "po-node-activity", director.detail));
	const sessions = director?.sessions ?? [];
	if (!sessions.length) article.append(node("p", "po-node-empty", "No director sessions linked"));
	else {
		const list = node("div", "po-mini-list");
		for (const item of sessions.slice(0, 2)) {
			const row = sessionButton(state, item.label, item.sessionId);
			if (item.detail) row.append(node("span", "po-tiny", item.detail));
			list.append(row);
		}
		article.append(list);
	}
	return article;
}

function renderWorkNode(state: PaneState, kind: "goals" | "prs"): HTMLElement {
	const items = kind === "goals" ? state.snapshot?.goals ?? [] : state.snapshot?.pullRequests ?? [];
	const article = node("article", `po-node po-${kind}`);
	article.append(nodeHeader(kind === "goals" ? "Goals" : "Pull Requests", kind === "goals" ? "Verified execution" : "Review + sign-off"));
	const metric = node("div", "po-node-metric");
	metric.append(node("strong", "", state.snapshot ? String(items.length) : "—"), node("span", "", kind === "goals" ? "tracked goals" : "tracked pull requests"));
	article.append(metric, miniItems(items, kind === "goals" ? "No linked goals" : "No linked pull requests", state));
	return article;
}

function renderConnector(label: string): HTMLElement {
	const connector = node("div", "po-connector");
	connector.setAttribute("aria-hidden", "true");
	connector.append(node("span", "po-connector-line"), node("span", "po-connector-label", label), node("span", "po-connector-arrow", "→"));
	return connector;
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
	copy.append(node("h2", "", "Live activity"), node("p", "po-muted", "Newest activity appears first"));
	const events = newestActivity(state);
	head.append(copy, node("span", "po-count", `${events.length} of 50 retained`));
	section.append(head);
	if (!events.length) {
		section.append(emptyState("No activity yet", "Scanner, director, goal, and review events will appear when published to the pack store."));
		return section;
	}
	const feed = node("ol", "po-feed");
	feed.setAttribute("aria-label", "Live optimisation activity");
	feed.setAttribute("aria-live", "polite");
	for (const event of events) {
		const item = node("li", `po-feed-row is-${event.kind}`);
		const time = node("time", "", activityTime(event.at));
		if (event.at) time.dateTime = event.at;
		item.append(time, node("strong", "", event.actor), node("span", "", event.message));
		if (event.sessionId) item.append(sessionButton(state, "Open session", event.sessionId));
		else if (event.tab) {
			const action = button(`${TABS.find((tab) => tab.id === event.tab)?.label ?? "Open"} →`, `navigate:${event.tab}`, "po-feed-action");
			action.disabled = state.host?.capabilities?.ui !== true;
			item.append(action);
		} else item.append(node("span", "po-feed-empty-action", "No linked target"));
		feed.append(item);
	}
	section.append(feed);
	return section;
}

function renderFlow(state: PaneState): HTMLElement {
	const wrapper = node("div", "po-view");
	const panel = node("section", "po-panel");
	const head = node("div", "po-section-head po-panel-head");
	const copy = node("div");
	copy.append(node("h2", "", "Live optimisation pipeline"), node("p", "po-muted", "Store-backed operational state and evidence flow"));
	head.append(copy);
	panel.append(head);
	const flow = node("div", "po-flow");
	flow.append(
		renderScanner(state),
		renderConnector("hypothesis.write"),
		renderRegistryNode(state),
		renderConnector("hypothesis.rank"),
		renderDirector(state),
		renderConnector("goal.create"),
		renderWorkNode(state, "goals"),
		renderConnector("evidence + diff"),
		renderWorkNode(state, "prs"),
	);
	panel.append(flow, renderActivity(state));
	wrapper.append(panel);
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
	const section = node("section", "po-panel");
	const head = node("div", "po-section-head po-panel-head");
	const copy = node("div");
	copy.append(node("h2", "", "Scan coverage"), node("p", "po-muted", "Project → component → subsystem or module → file"));
	head.append(copy);
	section.append(head);
	const roots = state.snapshot?.coverage ?? [];
	if (!roots.length) {
		section.append(emptyState("No coverage hierarchy", "A scanner can publish measured project, component, module, and file nodes to the pack store."));
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
	const section = node("section", "po-panel");
	const head = node("div", "po-section-head po-panel-head");
	const copy = node("div");
	copy.append(node("h2", "", "Hypothesis registry"), node("p", "po-muted", "Ranked performance opportunities with linked evidence"));
	head.append(copy, node("span", "po-count", String(state.snapshot?.registry.length ?? 0)));
	section.append(head);
	const items = state.snapshot?.registry ?? [];
	if (!items.length) {
		section.append(emptyState("Registry is empty", "Evidence-backed performance hypotheses will appear when published to the pack store."));
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
		detail.append(evidence, sessionButton(state, "Open scanner session", selected.sessionId));
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
		.po-shell { min-height: 100%; padding: clamp(12px, 2.3cqi, 22px); display: grid; align-content: start; gap: 14px; }
		.po-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
		.po-header h1 { margin: 0; font-size: clamp(21px, 3.5cqi, 27px); line-height: 1.1; letter-spacing: -.035em; }
		.po-eyebrow { margin: 0 0 3px; color: var(--muted-foreground); font-size: 10px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
		.po-subtitle, .po-muted { margin: 4px 0 0; color: var(--muted-foreground); }
		.po-button, .po-row-button, .po-node-link, .po-feed-action { min-height: 33px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; color: var(--foreground); background: var(--card); cursor: pointer; }
		.performance-pane button:hover:not(:disabled) { border-color: color-mix(in oklch, var(--primary) 55%, var(--border)); background: color-mix(in oklch, var(--primary) 8%, var(--card)); }
		.performance-pane button:focus-visible, .performance-pane input:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
		.performance-pane button:disabled { opacity: .45; cursor: not-allowed; }
		.po-tabs { width: max-content; max-width: 100%; display: flex; gap: 3px; padding: 3px; overflow-x: auto; border-radius: 9px; background: color-mix(in oklch, var(--foreground) 7%, var(--background)); }
		.po-tab { flex: 0 0 auto; min-height: 31px; padding: 5px 12px; border: 0; border-radius: 7px; color: var(--muted-foreground); background: transparent; cursor: pointer; font-weight: 650; }
		.po-tab[aria-selected="true"] { color: var(--foreground); background: var(--card); box-shadow: 0 1px 4px color-mix(in oklch, var(--foreground) 10%, transparent); }
		.po-view { min-width: 0; }
		.po-panel { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--card); box-shadow: 0 10px 28px color-mix(in oklch, var(--foreground) 5%, transparent); }
		.po-section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
		.po-section-head h2 { margin: 0; font-size: 14px; line-height: 1.2; }
		.po-panel-head { min-height: 48px; padding: 9px 13px; border-bottom: 1px solid var(--border); }
		.po-count { padding: 3px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted-foreground); font-size: 10px; white-space: nowrap; }
		.po-flow { padding: 18px; display: grid; grid-template-columns: minmax(150px, 1fr) minmax(45px, .28fr) minmax(145px, 1fr) minmax(45px, .28fr) minmax(145px, 1fr) minmax(45px, .28fr) minmax(145px, 1fr) minmax(45px, .28fr) minmax(145px, 1fr); align-items: stretch; overflow-x: auto; background-image: radial-gradient(circle, color-mix(in oklch, var(--border) 72%, transparent) .7px, transparent .8px); background-size: 16px 16px; }
		.po-node { --node-color: var(--chart-1); min-width: 0; min-height: 214px; padding: 11px; display: flex; flex-direction: column; gap: 9px; border: 1px solid color-mix(in oklch, var(--node-color) 35%, var(--border)); border-top: 3px solid var(--node-color); border-radius: 10px; background: var(--card); }
		.po-registry-node { --node-color: var(--chart-4); } .po-director { --node-color: var(--chart-2); } .po-goals { --node-color: var(--chart-3); } .po-prs { --node-color: var(--chart-5); }
		.po-node-head { display: flex; align-items: flex-start; gap: 8px; }
		.po-node-title { min-width: 0; flex: 1; }
		.po-node-title h3 { margin: 1px 0 0; font-size: 12px; line-height: 1.2; }
		.po-node-title p { margin: 2px 0 0; color: var(--muted-foreground); font-size: 9px; text-transform: uppercase; letter-spacing: .07em; }
		.po-node-icon { width: 32px; height: 32px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 8px; color: var(--node-color); background: color-mix(in oklch, var(--node-color) 12%, var(--card)); font-weight: 800; }
		.po-state { flex: 0 0 auto; padding: 2px 6px; border-radius: 999px; color: var(--muted-foreground); background: color-mix(in oklch, var(--foreground) 7%, var(--card)); font-size: 9px; font-weight: 750; white-space: nowrap; }
		.po-state.is-active { color: var(--positive); background: color-mix(in oklch, var(--positive) 10%, var(--card)); } .po-state.is-paused { color: var(--warning); background: color-mix(in oklch, var(--warning) 10%, var(--card)); }
		.po-scanner-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
		.po-scanner-metric { min-width: 0; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--background); }
		.po-scanner-metric strong { display: block; font-size: 21px; line-height: 1; letter-spacing: -.04em; }
		.po-scanner-metric span { display: block; margin-top: 4px; color: var(--muted-foreground); font-size: 8px; line-height: 1.25; text-transform: uppercase; letter-spacing: .04em; }
		.po-node-metric { display: flex; align-items: baseline; gap: 6px; margin-top: 4px; }
		.po-node-metric strong { font-size: 22px; line-height: 1; letter-spacing: -.04em; }
		.po-node-metric span { color: var(--muted-foreground); font-size: 9px; text-transform: uppercase; }
		.po-node-activity, .po-node-empty { margin: 0; color: var(--muted-foreground); font-size: 10px; }
		.po-node-activity strong { color: var(--foreground); }
		.po-node-empty { padding: 9px; border: 1px dashed var(--border); border-radius: 7px; text-align: center; }
		.po-mini-list { display: grid; gap: 5px; }
		.po-mini-row, .po-row-button { width: 100%; min-width: 0; min-height: 31px; padding: 6px 7px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; border-radius: 7px; text-align: left; font-size: 10px; }
		.po-mini-row { border: 1px solid transparent; background: color-mix(in oklch, var(--foreground) 6%, var(--card)); }
		.po-mini-row > span:first-child, .po-row-button { overflow: hidden; text-overflow: ellipsis; }
		.po-tiny { color: var(--node-color, var(--muted-foreground)); font-size: 9px; white-space: nowrap; }
		.po-node-link { margin-top: auto; min-height: 26px; padding: 3px 0; border: 0; color: var(--node-color); background: transparent; text-align: right; font-size: 9px; font-weight: 750; }
		.po-connector { min-width: 45px; display: grid; grid-template-columns: minmax(8px, 1fr) auto auto; align-items: center; color: var(--muted-foreground); }
		.po-connector-line { border-top: 2px solid var(--border); }
		.po-connector-label { padding: 3px 5px; border: 1px solid var(--border); border-radius: 5px; background: var(--card); color: var(--muted-foreground); font-size: 8px; font-weight: 700; white-space: nowrap; }
		.po-connector-arrow { font-size: 15px; }
		.po-sprite { position: relative; flex: 0 0 auto; width: 38px; height: 34px; color: var(--chart-1); image-rendering: pixelated; filter: drop-shadow(0 3px 2px color-mix(in oklch, var(--foreground) 13%, transparent)); }
		.po-pixel { position: absolute; width: ${100 / BODY_WIDTH}%; height: ${100 / BODY_HEIGHT}%; } .pixel-k, .pixel-eye { background: var(--foreground); } .pixel-m { background: var(--chart-1); } .pixel-l { background: color-mix(in oklch, var(--chart-1) 55%, var(--card)); } .pixel-d { background: color-mix(in oklch, var(--chart-1) 65%, var(--foreground)); }
		.po-activity { border-top: 1px solid var(--border); background: color-mix(in oklch, var(--chart-1) 3%, var(--card)); }
		.po-activity > .po-section-head { min-height: 43px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
		.po-feed { max-height: 240px; overflow-y: auto; list-style: none; margin: 0; padding: 0; }
		.po-feed-row { min-height: 42px; padding: 7px 12px; display: grid; grid-template-columns: minmax(105px, .55fr) minmax(130px, .7fr) minmax(220px, 1.4fr) auto; align-items: center; gap: 9px; border-bottom: 1px solid var(--border); }
		.po-feed-row time { color: var(--muted-foreground); font-size: 9px; } .po-feed-row strong { font-size: 10px; } .po-feed-row > span { min-width: 0; overflow-wrap: anywhere; font-size: 10px; }
		.po-feed-row::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--info); grid-column: 1; display: none; } .po-feed-row.is-success { box-shadow: inset 2px 0 var(--positive); } .po-feed-row.is-warning { box-shadow: inset 2px 0 var(--warning); } .po-feed-row.is-error { box-shadow: inset 2px 0 var(--negative); }
		.po-feed-action, .po-feed-row .po-row-button { width: auto; min-height: 27px; padding: 4px 7px; font-size: 9px; white-space: nowrap; }
		.po-feed-empty-action { color: var(--muted-foreground); font-size: 9px !important; }
		.po-empty { margin: 15px; padding: 22px; border: 1px dashed var(--border); border-radius: 10px; text-align: center; color: var(--muted-foreground); background: color-mix(in oklch, var(--background) 64%, transparent); }
		.po-empty strong { color: var(--foreground); } .po-empty p { margin: 5px auto 0; max-width: 55ch; }
		.po-browser { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(340px, 1.2fr); min-height: 450px; }
		.po-browser-list { min-width: 0; padding: 10px; border-right: 1px solid var(--border); overflow: auto; }
		.po-search { width: 100%; height: 33px; margin-bottom: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; color: var(--foreground); background: var(--background); }
		.po-tree-row { width: 100%; min-height: 31px; padding: 4px 7px 4px calc(7px + var(--depth) * 16px); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; border: 0; border-radius: 7px; color: var(--foreground); background: transparent; text-align: left; }
		.po-tree-row[aria-pressed="true"], .po-hypothesis-row[aria-pressed="true"] { background: color-mix(in oklch, var(--chart-1) 10%, var(--card)); box-shadow: inset 2px 0 var(--chart-1); }
		.po-coverage-state { color: var(--muted-foreground); font-size: 9px; white-space: nowrap; } .po-coverage-state.is-scanned { color: var(--positive); } .po-coverage-state.is-stale { color: var(--warning); }
		.po-browser-detail { min-width: 0; padding: clamp(15px, 2.5cqi, 22px); overflow: auto; }
		.po-browser-detail h3 { margin: 0; font-size: 18px; line-height: 1.2; }
		.po-detail-copy { color: var(--muted-foreground); overflow-wrap: anywhere; }
		.po-facts { margin: 16px 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
		.po-facts > div { min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--background); }
		.po-facts dt { color: var(--muted-foreground); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; } .po-facts dd { margin: 3px 0 0; overflow-wrap: anywhere; font-weight: 650; }
		.po-hypothesis-row { width: 100%; min-height: 61px; padding: 8px; display: grid; grid-template-columns: 43px minmax(0, 1fr); gap: 2px 8px; align-items: center; border: 0; border-bottom: 1px solid var(--border); border-radius: 7px; color: var(--foreground); background: transparent; text-align: left; }
		.po-hypothesis-row .po-confidence { grid-row: 1 / 3; color: var(--chart-4); font-size: 15px; } .po-hypothesis-row .po-tiny { color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; }
		.po-evidence { margin-bottom: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--background); } .po-evidence p { margin: 6px 0 0; color: var(--muted-foreground); overflow-wrap: anywhere; }
		.po-diagnostic { margin: 0; padding: 9px 11px; border: 1px solid var(--warning); border-radius: 8px; color: var(--warning); background: color-mix(in oklch, var(--warning) 8%, transparent); }
		@container (max-width: 900px) {
			.po-flow { grid-template-columns: 1fr; gap: 0; overflow: visible; }
			.po-node { min-height: 0; }
			.po-connector { min-height: 48px; grid-template-columns: 1fr; grid-template-rows: 1fr auto auto 1fr; justify-items: center; }
			.po-connector-line { width: 2px; height: 100%; border-top: 0; border-left: 2px solid var(--border); }
			.po-connector-arrow { transform: rotate(90deg); }
		}
		@container (max-width: 650px) {
			.po-header { align-items: stretch; flex-direction: column; } .po-header .po-button { width: 100%; }
			.po-browser { grid-template-columns: 1fr; } .po-browser-list { max-height: 320px; border-right: 0; border-bottom: 1px solid var(--border); }
			.po-feed-row { grid-template-columns: 90px minmax(0, 1fr) auto; } .po-feed-row > span:nth-child(3) { grid-column: 2 / 3; } .po-feed-row > button, .po-feed-empty-action { grid-column: 3; grid-row: 1 / 3; }
		}
		@container (max-width: 430px) { .po-shell { padding: 10px; } .po-tabs { width: 100%; } .po-tab { flex: 1; padding-inline: 7px; } .po-facts { grid-template-columns: 1fr; } }
	`;
	return style;
}

function renderPane(state: PaneState): void {
	const shell = node("div", "po-shell");
	shell.append(renderHeader(state), renderTabs(state));
	if (state.storeState === "error" && !state.demo) shell.append(node("p", "po-diagnostic", `Store read failed${state.storeDiagnostic ? ` (${state.storeDiagnostic})` : ""}. Existing data was not replaced.`));
	const view = state.tab === "coverage" ? renderCoverage(state) : state.tab === "registry" ? renderRegistry(state) : renderFlow(state);
	view.id = `po-view-${state.tab}`;
	view.setAttribute("role", "tabpanel");
	view.setAttribute("aria-labelledby", `po-tab-${state.tab}`);
	shell.append(view);
	state.root.replaceChildren(styles(), shell);
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

async function refreshSnapshot(state: PaneState): Promise<void> {
	if (state.demo) {
		state.snapshot = DEMO_SNAPSHOT;
		state.storeState = "ready";
		state.loading = false;
		renderPane(state);
		return;
	}
	const canReadStore = state.host?.capabilities?.store === true;
	const canReadProject = state.host?.capabilities?.projectSnapshot === true && Boolean(state.host.project);
	if (!canReadStore && !canReadProject) {
		state.storeState = "unavailable";
		state.loading = false;
		renderPane(state);
		return;
	}
	state.loading = true;
	renderPane(state);
	const [storedResult, project] = await Promise.all([
		canReadStore
			? readStoredValue<unknown>(state, SNAPSHOT_KEY)
			: Promise.resolve({ state: "error" as const, diagnostic: "capability-unavailable" }),
		canReadProject
			? state.host!.project!.snapshot().catch(() => null)
			: Promise.resolve(null),
	]);

	let stored: PerformanceSnapshot | null = null;
	if (storedResult.state === "present") {
		stored = parseSnapshot(storedResult.value);
		if (stored) {
			state.storeState = "ready";
			state.storeDiagnostic = undefined;
		} else {
			state.storeState = "error";
			state.storeDiagnostic = "unsupported-snapshot";
		}
	} else if (storedResult.state === "absent") {
		state.storeState = "absent";
		state.storeDiagnostic = undefined;
	} else if (!canReadStore) {
		state.storeState = project ? "absent" : "unavailable";
		state.storeDiagnostic = undefined;
	} else {
		state.storeState = "error";
		state.storeDiagnostic = storedResult.diagnostic;
	}
	state.snapshot = project ? mergeProjectSnapshot(stored, project) : stored;
	state.loading = false;
	renderPane(state);
}

async function persistTab(state: PaneState): Promise<void> {
	if (state.demo || state.host?.capabilities?.store !== true || !state.host.store?.put) return;
	try {
		await state.host.store.put<UiPreferences>(UI_KEY, { version: 1, tab: state.tab });
	} catch {
		// Preferences are best-effort and never replace the measured snapshot.
	}
}

function observeSession(state: PaneState): void {
	if (state.unsubscribe || state.demo || state.host?.capabilities?.session !== true || !state.host.session) return;
	try {
		state.unsubscribe = state.host.session.subscribe("status", (payload) => {
			if (state.demo) return;
			const kind: FeedKind = payload.status === "error" ? "error" : payload.status === "idle" ? "success" : "info";
			state.liveEvents.unshift({
				id: `session-${Date.now()}-${state.liveEvents.length}`,
				at: new Date().toISOString(),
				kind,
				actor: "Current session",
				message: payload.detail ? `Session ${payload.status}: ${payload.detail}` : `Session status changed to ${payload.status}.`,
			});
			state.liveEvents = state.liveEvents.slice(0, 50);
			renderPane(state);
		});
	} catch {
		// Stored activity remains usable when a host has no session stream.
	}
}

async function initialize(state: PaneState, requestedTab?: TabId): Promise<void> {
	state.initialized = true;
	observeSession(state);
	if (!requestedTab && !state.demo && state.host?.capabilities?.store === true) {
		const result = await readStoredValue<unknown>(state, UI_KEY);
		if (result.state === "present" && isObject(result.value) && result.value.version === 1) state.tab = parseTab(result.value.tab) ?? state.tab;
	}
	await refreshSnapshot(state);
}

function switchTab(state: PaneState, tab: TabId): void {
	state.tab = tab;
	renderPane(state);
	void persistTab(state);
}

function handleAction(state: PaneState, action: string): void {
	if (action.startsWith("tab:")) {
		const tab = parseTab(action.slice(4));
		if (tab) switchTab(state, tab);
		return;
	}
	if (action === "refresh") {
		void refreshSnapshot(state);
		return;
	}
	if (action.startsWith("navigate:")) {
		const tab = parseTab(action.slice(9));
		if (!tab || state.host?.capabilities?.ui !== true || !state.host.ui) return;
		state.tab = tab;
		void persistTab(state);
		state.host.ui.navigate({ route: ROUTE_ID, params: { tab } });
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
	}
}

export default function createPerformancePanel() {
	const root = node("div", "performance-pane");
	root.dataset.testid = "performance-optimisation-panel";
	const state: PaneState = {
		root,
		tab: "flow",
		snapshot: null,
		loading: true,
		storeState: "unknown",
		initialized: false,
		demo: false,
		liveEvents: [],
		coverageQuery: "",
		registryQuery: "",
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
		renderPane(state);
		const replacement = state.root.querySelector<HTMLInputElement>(`input[data-input="${target.dataset.input}"]`);
		replacement?.focus();
		replacement?.setSelectionRange(target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length);
	});

	return {
		render(params: Record<string, unknown> | undefined, host: HostApi | undefined) {
			state.host = host;
			const requestedTab = parseTab(params?.tab);
			if (requestedTab) state.tab = requestedTab;
			const demo = params?.demo === true || params?.demo === "true";
			const demoChanged = demo !== state.demo;
			state.demo = demo;
			if (!state.initialized) {
				renderPane(state);
				void initialize(state, requestedTab);
			} else if (demoChanged) {
				state.snapshot = demo ? DEMO_SNAPSHOT : null;
				if (!demo) observeSession(state);
				void refreshSnapshot(state);
			} else {
				observeSession(state);
				renderPane(state);
			}
			return root;
		},
	};
}

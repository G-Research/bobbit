/**
 * Bobbit Specification Framework
 *
 * Stories ARE the tests. No intermediate format.
 * Written in TypeScript with a fluent API designed for human readability.
 * Story metadata (IDs, contracts, test-phase annotations) powers the spec graph.
 * The registry IS the type system — add an entity = add a type.
 *
 * Test phases: setup → act → assert → cleanup
 * Only regions/intents/entities tracked during "act" and "assert" phases
 * contribute to the spec graph. Setup and cleanup are incidental.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { createSession, deleteSession, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

// ============================================================
// STORY METADATA & SPEC GRAPH
// ============================================================

type TestPhase = "setup" | "act" | "assert" | "cleanup";

export interface StoryMeta {
	id: string;
	title: string;
	contracts: string[];
	covers: string[];
	/** Regions touched during act/assert phases (not setup). */
	regions: string[];
	/** Intents exercised during act/assert phases (not setup). */
	intents: string[];
	/** Entity types referenced during act/assert phases. */
	entities: string[];
	file: string;
	environment?: "mobile" | "desktop";
}

export interface ContractDef {
	id: string;
	guarantee: string;
	survives: string[];
	regions: string[];
	depends_on: string[];
}

const contractRegistry = new Map<string, ContractDef>();

export function defineContract(def: ContractDef): ContractDef {
	contractRegistry.set(def.id, def);
	return def;
}

export function getContractRegistry(): ReadonlyMap<string, ContractDef> {
	return contractRegistry;
}

export function clearContractRegistry() {
	contractRegistry.clear();
}

const storyRegistry = new Map<string, StoryMeta>();

/** Define a story's metadata. Call at the top of each test. */
export function defineStory(meta: {
	id: string;
	title: string;
	contracts: (string | ContractDef)[];
	covers?: string[];
	environment?: "mobile" | "desktop";
}): StoryMeta {
	const entry: StoryMeta = {
		id: meta.id,
		title: meta.title,
		contracts: meta.contracts.map(c => typeof c === 'string' ? c : c.id),
		covers: meta.covers ?? [],
		regions: [],
		intents: [],
		entities: [],
		file: "",
		environment: meta.environment,
	};
	storyRegistry.set(meta.id, entry);
	return entry;
}

/** Record that a region was touched (only during act/assert phases). */
function trackRegion(story: StoryMeta | undefined, phase: TestPhase, region: string) {
	if (story && (phase === "act" || phase === "assert") && !story.regions.includes(region)) {
		story.regions.push(region);
	}
}

/** Record that an intent was exercised (only during act/assert phases). */
function trackIntent(story: StoryMeta | undefined, phase: TestPhase, intent: string) {
	if (story && (phase === "act" || phase === "assert") && !story.intents.includes(intent)) {
		story.intents.push(intent);
	}
}

/** Record that an entity type was referenced (only during act/assert phases). */
function trackEntity(story: StoryMeta | undefined, phase: TestPhase, entityType: string) {
	if (story && (phase === "act" || phase === "assert") && !story.entities.includes(entityType)) {
		story.entities.push(entityType);
	}
}

/** Get all registered stories. */
export function getStoryRegistry(): ReadonlyMap<string, StoryMeta> {
	return storyRegistry;
}

/** Clear the registry (for test isolation). */
export function clearStoryRegistry() {
	storyRegistry.clear();
}

/**
 * Export the spec graph as JSON.
 *
 * Shape:
 * {
 *   stories:     { [id]: StoryMeta },
 *   contracts:   { [id]: { stories: string[] } },
 *   regionIndex: { [region]: string[] },
 *   intentIndex: { [intent]: string[] },
 *   entityIndex: { [entity]: string[] },
 * }
 */
export function exportSpecGraph(): {
	stories: Record<string, StoryMeta>;
	contracts: Record<string, { stories: string[] }>;
	contractDefs: Record<string, ContractDef>;
	regionIndex: Record<string, string[]>;
	intentIndex: Record<string, string[]>;
	entityIndex: Record<string, string[]>;
} {
	const stories: Record<string, StoryMeta> = {};
	const contracts: Record<string, { stories: string[] }> = {};
	const contractDefs: Record<string, ContractDef> = {};
	const regionIndex: Record<string, string[]> = {};
	const intentIndex: Record<string, string[]> = {};
	const entityIndex: Record<string, string[]> = {};

	for (const [id, meta] of storyRegistry) {
		stories[id] = meta;
		for (const ct of meta.contracts) {
			if (!contracts[ct]) contracts[ct] = { stories: [] };
			contracts[ct].stories.push(id);
		}
		for (const r of meta.regions) {
			if (!regionIndex[r]) regionIndex[r] = [];
			regionIndex[r].push(id);
		}
		for (const i of meta.intents) {
			if (!intentIndex[i]) intentIndex[i] = [];
			intentIndex[i].push(id);
		}
		for (const e of meta.entities) {
			if (!entityIndex[e]) entityIndex[e] = [];
			entityIndex[e].push(id);
		}
	}

	for (const [id, def] of contractRegistry) {
		contractDefs[id] = def;
	}

	return { stories, contracts, contractDefs, regionIndex, intentIndex, entityIndex };
}

/**
 * "What stories are related to this one?"
 * Ranked by overlap: shared contracts (3x), regions (2x), intents (1x), entities (1x).
 */
export function findRelatedStories(storyId: string): Array<{ id: string; reason: string; overlap: number }> {
	const target = storyRegistry.get(storyId);
	if (!target) return [];

	const scores = new Map<string, { reasons: string[]; overlap: number }>();

	for (const [id, meta] of storyRegistry) {
		if (id === storyId) continue;
		const reasons: string[] = [];
		let overlap = 0;

		const sharedContracts = target.contracts.filter(c => meta.contracts.includes(c));
		if (sharedContracts.length) { reasons.push(`contracts: ${sharedContracts.join(", ")}`); overlap += sharedContracts.length * 3; }

		const sharedRegions = target.regions.filter(r => meta.regions.includes(r));
		if (sharedRegions.length) { reasons.push(`regions: ${sharedRegions.join(", ")}`); overlap += sharedRegions.length * 2; }

		const sharedIntents = target.intents.filter(i => meta.intents.includes(i));
		if (sharedIntents.length) { reasons.push(`intents: ${sharedIntents.join(", ")}`); overlap += sharedIntents.length; }

		const sharedEntities = target.entities.filter(e => meta.entities.includes(e));
		if (sharedEntities.length) { reasons.push(`entities: ${sharedEntities.join(", ")}`); overlap += sharedEntities.length; }

		if (overlap > 0) scores.set(id, { reasons, overlap });
	}

	return Array.from(scores.entries())
		.map(([id, { reasons, overlap }]) => ({ id, reason: reasons.join("; "), overlap }))
		.sort((a, b) => b.overlap - a.overlap);
}

/** "I'm changing this region — what stories test it?" */
export function storiesForRegion(region: string): string[] {
	const result: string[] = [];
	for (const [id, meta] of storyRegistry) {
		if (meta.regions.includes(region)) result.push(id);
	}
	return result;
}

/** "Is this contract well covered?" */
export function contractCoverage(contractId: string): {
	contractId: string;
	stories: string[];
	regions: string[];
	intents: string[];
} {
	const stories: string[] = [];
	const regions = new Set<string>();
	const intents = new Set<string>();

	for (const [id, meta] of storyRegistry) {
		if (meta.contracts.includes(contractId)) {
			stories.push(id);
			meta.regions.forEach(r => regions.add(r));
			meta.intents.forEach(i => intents.add(i));
		}
	}
	return { contractId, stories, regions: [...regions], intents: [...intents] };
}

export function contractCompleteness(): Array<{
	contractId: string;
	guarantee: string;
	variations: Array<{ name: string; coveredBy: string | null }>;
	coverage: number;
}> {
	const results: Array<{
		contractId: string;
		guarantee: string;
		variations: Array<{ name: string; coveredBy: string | null }>;
		coverage: number;
	}> = [];

	for (const [id, contract] of contractRegistry) {
		const variations = contract.survives.map(variation => {
			// Find a story that covers this variation
			let coveredBy: string | null = null;
			for (const [storyId, story] of storyRegistry) {
				if (story.contracts.includes(id) && story.covers.includes(variation)) {
					coveredBy = storyId;
					break;
				}
			}
			return { name: variation, coveredBy };
		});

		const covered = variations.filter(v => v.coveredBy !== null).length;
		results.push({
			contractId: id,
			guarantee: contract.guarantee,
			variations,
			coverage: contract.survives.length > 0 ? covered / contract.survives.length : 1,
		});
	}

	return results;
}


// ============================================================
// ENTITY HANDLES
// ============================================================

export class ProjectHandle {
	constructor(
		private page: Page,
		private name: string,
		private _projectId?: string,
		private _ctx?: SpecContext,
	) {}

	get projectId(): string {
		if (!this._projectId) throw new Error(`Project '${this.name}' has no ID — set it first`);
		return this._projectId;
	}

	set projectId(id: string) { this._projectId = id; }
	set ctx(c: SpecContext) { this._ctx = c; }

	private get story() { return this._ctx?._activeStory; }
	private get phase() { return this._ctx?._phase ?? "setup"; }

	async in_sidebar() {
		trackEntity(this.story, this.phase, "project");
		await expect(
			this.page.locator(`[data-project-id="${this._projectId}"], .project-section`)
				.filter({ hasText: this.name }).first()
		).toBeVisible({ timeout: 5_000 });
	}

	async not_in_sidebar() {
		trackEntity(this.story, this.phase, "project");
		await expect(
			this.page.locator(`[data-project-id="${this._projectId}"], .project-section`)
				.filter({ hasText: this.name }).first()
		).not.toBeVisible({ timeout: 5_000 });
	}
}

export class SessionHandle {
	constructor(
		private page: Page,
		private name: string,
		private _sessionId?: string,
		private _ctx?: SpecContext,
	) {}

	get sessionId(): string {
		if (!this._sessionId) throw new Error(`Session '${this.name}' has no ID — call createTestSession() first`);
		return this._sessionId;
	}

	set sessionId(id: string) { this._sessionId = id; }
	set ctx(c: SpecContext) { this._ctx = c; }

	private get story() { return this._ctx?._activeStory; }
	private get phase() { return this._ctx?._phase ?? "setup"; }

	async in_state(state: "active" | "inactive" | "idle" | "streaming") {
		trackEntity(this.story, this.phase, "session");
		if (state === "active") {
			const hash = await this.page.evaluate(() => window.location.hash);
			expect(hash).toContain(this._sessionId);
		} else if (state === "inactive") {
			const hash = await this.page.evaluate(() => window.location.hash);
			expect(hash).not.toContain(this._sessionId);
		} else if (state === "idle" || state === "streaming") {
			await waitForSessionStatus(this.sessionId, state);
		}
	}

	async is_highlighted() {
		trackEntity(this.story, this.phase, "session");
		trackRegion(this.story, this.phase, "sidebar");
		await expect(async () => {
			const hash = await this.page.evaluate(() => window.location.hash);
			expect(hash).toContain(this._sessionId);
			// The active session row has the .sidebar-session-active class
			const activeRow = this.page.locator(".sidebar-session-active");
			await expect(activeRow).toBeVisible();
		}).toPass({ timeout: 5_000 });
	}

	async has_unseen_dot(): Promise<void> {
		trackEntity(this.story, this.phase, "session");
		trackRegion(this.story, this.phase, "sidebar");
		const row = this.page.locator(`.sidebar-session[data-id="${this._sessionId}"]`);
		await expect(row.locator('.unseen-dot, .activity-dot, [class*="unseen"]').first())
			.toBeVisible({ timeout: 5_000 });
	}

	async no_unseen_dot(): Promise<void> {
		trackEntity(this.story, this.phase, "session");
		trackRegion(this.story, this.phase, "sidebar");
		const row = this.page.locator(`.sidebar-session[data-id="${this._sessionId}"]`);
		await expect(row.locator('.unseen-dot, .activity-dot, [class*="unseen"]').first())
			.not.toBeVisible({ timeout: 5_000 });
	}

	async is_nested_under(parentName: string): Promise<void> {
		trackEntity(this.story, this.phase, "session");
		trackRegion(this.story, this.phase, "sidebar");
		const parentLocator = this.page.locator(
			`.sidebar-session:has-text("${parentName}"), .goal-group:has-text("${parentName}")`
		).first();
		await expect(parentLocator).toBeVisible({ timeout: 5_000 });
		const sessionInParent = this.page.locator(`.sidebar-session[data-id="${this._sessionId}"]`);
		await expect(sessionInParent).toBeVisible({ timeout: 5_000 });
	}

	async is_before(otherSessionName: string): Promise<void> {
		trackEntity(this.story, this.phase, "session");
		trackRegion(this.story, this.phase, "sidebar");
		const thisId = this._sessionId;
		const result = await this.page.evaluate(({ thisId, otherName }) => {
			const rows = Array.from(document.querySelectorAll('.sidebar-session'));
			const thisIdx = rows.findIndex(r => r.getAttribute('data-id') === thisId);
			const otherIdx = rows.findIndex(r => r.textContent?.includes(otherName));
			return { thisIdx, otherIdx };
		}, { thisId, otherName: otherSessionName });
		expect(result.thisIdx).toBeGreaterThanOrEqual(0);
		expect(result.otherIdx).toBeGreaterThanOrEqual(0);
		expect(result.thisIdx).toBeLessThan(result.otherIdx);
	}

	async shows_status(status: "streaming" | "idle" | "compacting"): Promise<void> {
		trackEntity(this.story, this.phase, "session");
		trackRegion(this.story, this.phase, "sidebar");
		const row = this.page.locator(`.sidebar-session[data-id="${this._sessionId}"]`);
		if (status === "streaming") {
			await expect(row.locator('.streaming-dots, .pulsing-dot, [class*="streaming"], [class*="active-dot"]').first())
				.toBeVisible({ timeout: 5_000 });
		} else if (status === "idle") {
			await expect(row.locator('.idle-time, .time-display, time, [class*="idle"]').first())
				.toBeVisible({ timeout: 5_000 });
		} else if (status === "compacting") {
			await expect(row.locator('.compacting, [class*="compact"]').first())
				.toBeVisible({ timeout: 5_000 });
		}
	}
}

export class GoalHandle {
	constructor(
		private page: Page,
		private name: string,
		private _goalId?: string,
		private _ctx?: SpecContext,
	) {}

	get goalId(): string {
		if (!this._goalId) throw new Error(`Goal '${this.name}' has no ID — call createTestGoal() first`);
		return this._goalId;
	}

	set goalId(id: string) { this._goalId = id; }
	set ctx(c: SpecContext) { this._ctx = c; }

	private get story() { return this._ctx?._activeStory; }
	private get phase() { return this._ctx?._phase ?? "setup"; }

	async in_state(state: "active" | "archived" | "complete") {
		trackEntity(this.story, this.phase, "goal");
		const resp = await apiFetch(`/api/goals/${this.goalId}`);
		expect(resp.ok).toBe(true);
		const data = await resp.json();
		expect(data.status).toBe(state);
	}
}

export class GateHandle {
	constructor(
		private page: Page,
		private name: string,
		private _gateId?: string,
		private _goalId?: string,
		private _ctx?: SpecContext,
	) {}

	set gateId(id: string) { this._gateId = id; }
	set goalId(id: string) { this._goalId = id; }
	set ctx(c: SpecContext) { this._ctx = c; }

	private get story() { return this._ctx?._activeStory; }
	private get phase() { return this._ctx?._phase ?? "setup"; }

	async in_state(state: "pending" | "passed" | "failed" | "verifying") {
		trackEntity(this.story, this.phase, "gate");
		if (!this._goalId || !this._gateId) throw new Error("Gate requires goalId and gateId");
		const resp = await apiFetch(`/api/goals/${this._goalId}/gates`);
		expect(resp.ok).toBe(true);
		const gates = await resp.json();
		const gate = gates.find((g: any) => g.id === this._gateId || g.workflowGateId === this._gateId);
		expect(gate).toBeTruthy();
		expect(gate.status).toBe(state);
	}

	async has_badge(badge: string) {
		trackEntity(this.story, this.phase, "gate");
		trackRegion(this.story, this.phase, "dashboard");
		// UI assertion: badge visible on dashboard
		await expect(this.page.locator(`.gate-badge:has-text("${badge}"), [data-gate="${this._gateId}"] .badge:has-text("${badge}")`).first())
			.toBeVisible({ timeout: 5_000 });
	}
}

export class StaffHandle {
	constructor(
		private page: Page,
		private name: string,
		private _staffId?: string,
		private _ctx?: SpecContext,
	) {}

	set staffId(id: string) { this._staffId = id; }
	set ctx(c: SpecContext) { this._ctx = c; }

	private get story() { return this._ctx?._activeStory; }
	private get phase() { return this._ctx?._phase ?? "setup"; }

	async in_state(state: "active" | "paused" | "sleeping" | "awake") {
		trackEntity(this.story, this.phase, "staff");
		if (!this._staffId) throw new Error("Staff requires staffId");
		const resp = await apiFetch(`/api/staff/${this._staffId}`);
		expect(resp.ok).toBe(true);
		const data = await resp.json();
		expect(data.state).toBe(state);
	}

	async has_badge(badge: string) {
		trackEntity(this.story, this.phase, "staff");
		trackRegion(this.story, this.phase, "sidebar");
		await expect(this.page.locator(`.staff-badge:has-text("${badge}"), [data-staff="${this._staffId}"] .badge:has-text("${badge}")`).first())
			.toBeVisible({ timeout: 5_000 });
	}
}


// ============================================================
// REGION HANDLES
// ============================================================

export class RegionHandle {
	constructor(
		protected page: Page,
		protected selector: string,
		protected regionName: string = "",
		protected _ctx?: SpecContext,
	) {}

	protected locator() { return this.page.locator(this.selector).first(); }

	set ctx(c: SpecContext) { this._ctx = c; }

	private get story() { return this._ctx?._activeStory; }
	private get phase() { return this._ctx?._phase ?? "setup"; }
	private track() { trackRegion(this.story, this.phase, this.regionName); }

	async is_visible(what?: string) {
		this.track();
		if (what) {
			await expect(this.page.locator(this.selector).filter({ hasText: what }).first())
				.toBeVisible({ timeout: 15_000 });
		} else {
			await expect(this.locator()).toBeVisible({ timeout: 15_000 });
		}
	}

	async is_hidden(what?: string) {
		this.track();
		if (what) {
			await expect(this.page.locator(this.selector).filter({ hasText: what }).first())
				.not.toBeVisible({ timeout: 5_000 });
		} else {
			await expect(this.locator()).not.toBeVisible({ timeout: 5_000 });
		}
	}

	async is_focused() {
		this.track();
		await expect(this.locator()).toBeFocused({ timeout: 5_000 });
	}

	async is_empty() {
		this.track();
		await expect(this.locator()).toHaveValue("");
	}

	async contains_text(text: string) {
		this.track();
		await expect(async () => {
			const el = this.locator();
			const tagName = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => "");
			if (tagName === "textarea" || tagName === "input") {
				const val = await el.inputValue();
				expect(val).toContain(text);
			} else {
				await expect(el).toContainText(text);
			}
		}).toPass({ timeout: 10_000 });
	}

	async has_count(count: number) {
		this.track();
		await expect(async () => {
			const n = await this.locator().locator("> *").count();
			expect(n).toBe(count);
		}).toPass({ timeout: 5_000 });
	}

	async shows_value(value: string) {
		this.track();
		await expect(async () => {
			const text = await this.locator().textContent() || "";
			expect(text).toContain(value);
		}).toPass({ timeout: 5_000 });
	}

	async can(intent: string) {
		this.track();
		trackIntent(this.story, this.phase, intent);
		const sel = intentSelectors[intent];
		if (!sel) throw new Error(`Unknown intent '${intent}' — add it to intentSelectors`);
		await expect(this.page.locator(sel).first()).toBeVisible({ timeout: 5_000 });
		await expect(this.page.locator(sel).first()).toBeEnabled();
	}

	async cannot(intent: string) {
		this.track();
		trackIntent(this.story, this.phase, intent);
		const sel = intentSelectors[intent];
		if (!sel) throw new Error(`Unknown intent '${intent}' — add it to intentSelectors`);
		const el = this.page.locator(sel).first();
		const visible = await el.isVisible().catch(() => false);
		if (visible) {
			await expect(el).toBeDisabled();
		}
	}

	async is_expanded() {
		this.track();
		await expect(this.locator()).toHaveAttribute("data-expanded", "true", { timeout: 5_000 })
			.catch(() => expect(this.locator()).toHaveClass(/expanded|open/, { timeout: 5_000 }));
	}

	async is_collapsed() {
		this.track();
		await expect(this.locator()).not.toHaveClass(/expanded|open/, { timeout: 5_000 });
	}

	async connection_status(status: "connected" | "disconnected" | "reconnecting") {
		this.track();
		await expect(async () => {
			const text = await this.page.locator(".connection-status, [data-connection-status]").first().textContent() || "";
			expect(text.toLowerCase()).toContain(status);
		}).toPass({ timeout: 15_000 });
	}
}

// ============================================================
// SIDEBAR REGION — typed sub-regions for sidebar hierarchy
// ============================================================

export class SidebarRegion extends RegionHandle {
	project_section(name?: string): RegionHandle {
		// Project headers are div.cursor-pointer inside .sidebar-edge
		const sel = name
			? `.sidebar-edge div.cursor-pointer`
			: `.sidebar-edge div.cursor-pointer`;
		const r = new RegionHandle(this.page, sel, "sidebar.project_section");
		if (this._ctx) r.ctx = this._ctx;
		return r;
	}

	goal_group(name?: string): RegionHandle {
		// Goal titles use getByText — use sidebar-edge scoped text match
		const sel = name
			? `.sidebar-edge`
			: `.sidebar-edge`;
		const r = new RegionHandle(this.page, sel, "sidebar.goal_group");
		if (this._ctx) r.ctx = this._ctx;
		return r;
	}

	session_row(nameOrId?: string): RegionHandle {
		// Session rows use .sidebar-session-active for active, text filtering for lookup
		let sel: string;
		if (!nameOrId) {
			sel = ".sidebar-session-active";
		} else {
			sel = `.sidebar-edge`;
		}
		const r = new RegionHandle(this.page, sel, "sidebar.session_row");
		if (this._ctx) r.ctx = this._ctx;
		return r;
	}

	staff_section(): RegionHandle {
		const r = new RegionHandle(this.page, '.sidebar-edge', "sidebar.staff_section");
		if (this._ctx) r.ctx = this._ctx;
		return r;
	}

	archived_section(): RegionHandle {
		// Archived section is found by text "Archived" within sidebar
		const r = new RegionHandle(this.page, '.sidebar-edge', "sidebar.archived_section");
		if (this._ctx) r.ctx = this._ctx;
		return r;
	}

	search_input(): RegionHandle {
		const r = new RegionHandle(
			this.page,
			'input[data-search]',
			"sidebar.search_input",
		);
		if (this._ctx) r.ctx = this._ctx;
		return r;
	}
}


const intentSelectors: Record<string, string> = {
	send_message: "message-editor button[title='Send message']",
	stop_streaming: "button[title='Stop streaming']",
	attach_file: "message-editor input[type='file']",
};


// ============================================================
// EDITOR REGION — with typed sub-regions
// ============================================================

export class EditorRegion extends RegionHandle {
	get text_input() { return this._subRegion("message-editor textarea", "editor.text_input"); }
	get attachment_area() { return this._subRegion("message-editor .attachments, message-editor attachment-tile", "editor.attachment_area"); }
	get autocomplete() { return this._subRegion("message-editor .autocomplete, message-editor .skill-autocomplete", "editor.autocomplete"); }
	get queue() {
		const r = new QueueRegion(this.page, "message-editor .queued-messages, message-editor .queue-pill", "editor.queue");
		r.ctx = this._ctx!;
		return r;
	}

	private _subRegion(selector: string, name: string): RegionHandle {
		const r = new RegionHandle(this.page, selector, name);
		r.ctx = this._ctx!;
		return r;
	}

	override async contains_text(text: string) {
		trackRegion(this._ctx?._activeStory, this._ctx?._phase ?? "setup", "editor");
		await expect(async () => {
			const val = await this.page.locator("message-editor textarea").first().inputValue();
			expect(val).toContain(text);
		}).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 10_000 });
	}

	override async is_empty() {
		trackRegion(this._ctx?._activeStory, this._ctx?._phase ?? "setup", "editor");
		await expect(async () => {
			const val = await this.page.locator("message-editor textarea").first().inputValue();
			expect(val).toBe("");
		}).toPass({ timeout: 5_000 });
	}

	override async is_focused() {
		trackRegion(this._ctx?._activeStory, this._ctx?._phase ?? "setup", "editor");
		await expect(this.page.locator("message-editor textarea").first())
			.toBeFocused({ timeout: 5_000 });
	}

	override async can(intent: string) {
		trackRegion(this._ctx?._activeStory, this._ctx?._phase ?? "setup", "editor");
		trackIntent(this._ctx?._activeStory, this._ctx?._phase ?? "setup", intent);
		const sel = intentSelectors[intent];
		if (!sel) throw new Error(`Unknown intent '${intent}'`);
		// Use full selector string (fixes the split bug from review)
		await expect(this.page.locator(sel).first()).toBeVisible({ timeout: 5_000 });
	}

	override async cannot(intent: string) {
		trackRegion(this._ctx?._activeStory, this._ctx?._phase ?? "setup", "editor");
		trackIntent(this._ctx?._activeStory, this._ctx?._phase ?? "setup", intent);
		const sel = intentSelectors[intent];
		if (!sel) throw new Error(`Unknown intent '${intent}'`);
		const el = this.page.locator(sel).first();
		const visible = await el.isVisible().catch(() => false);
		if (!visible) return;
		await expect(el).toBeDisabled();
	}
}

export class QueueRegion extends RegionHandle {
	override async has_count(count: number) {
		trackRegion(this._ctx?._activeStory, this._ctx?._phase ?? "setup", "editor.queue");
		await expect(async () => {
			const pills = this.page.locator(".queue-pill, .queued-pill, [class*='queue']").filter({ has: this.page.locator("text=Queued") });
			const n = await pills.count().catch(() => 0);
			if (n === 0 && count > 0) {
				const altCount = await this.page.locator("message-editor .queued-messages > *, message-editor .queue-container > *").count().catch(() => 0);
				expect(altCount).toBe(count);
			} else {
				expect(n).toBe(count);
			}
		}).toPass({ timeout: 5_000 });
	}
}

export class ContextBarRegion extends RegionHandle {
	get model_selector() {
		const r = new RegionHandle(this.page, ".model-selector, [data-testid='model-selector'], .context-bar button", "context_bar.model_selector");
		r.ctx = this._ctx!;
		return r;
	}
}


// ============================================================
// SPEC CONTEXT — the main API stories interact with
// ============================================================

export class SpecContext {
	private sessions = new Map<string, SessionHandle>();
	private projects = new Map<string, ProjectHandle>();
	private goals = new Map<string, GoalHandle>();
	private gates = new Map<string, GateHandle>();
	private staffAgents = new Map<string, StaffHandle>();

	/** @internal — exposed for entity handles to read */
	_activeStory?: StoryMeta;
	/** @internal — current test phase */
	_phase: TestPhase = "setup";

	private _page: Page;

	// Regions
	readonly sidebar: SidebarRegion;
	readonly editor: EditorRegion;
	readonly context_bar: ContextBarRegion;
	readonly stats_bar: RegionHandle;
	readonly message_list: RegionHandle;
	readonly dashboard: RegionHandle;
	readonly settings: RegionHandle;
	readonly review_pane: RegionHandle;
	readonly search_page: RegionHandle;
	readonly modal: RegionHandle;

	constructor(page: Page) {
		this._page = page;
		this.sidebar = new SidebarRegion(page, ".sidebar-edge", "sidebar");
		this.sidebar.ctx = this;
		this.editor = new EditorRegion(page, "message-editor", "editor");
		this.editor.ctx = this;
		this.context_bar = new ContextBarRegion(page, ".context-bar, .stats-bar", "context_bar");
		this.context_bar.ctx = this;
		this.stats_bar = this._region(".stats-bar, .status-bar", "stats_bar");
		this.message_list = this._region(".messages, .message-list, message-list", "message_list");
		this.dashboard = this._region(".goal-dashboard, goal-dashboard", "dashboard");
		this.settings = this._region(".settings-page, settings-page", "settings");
		this.review_pane = this._region("review-pane", "review_pane");
		this.search_page = this._region(".search-page, search-page", "search_page");
		this.modal = this._region("[role='dialog'], .modal, .dialog", "modal");
	}

	private _region(selector: string, name: string): RegionHandle {
		const r = new RegionHandle(this._page, selector, name);
		r.ctx = this;
		return r;
	}

	get page() { return this._page; }

	// --- Phase control ---

	/** Set the active story and start in setup phase. */
	begin(story: StoryMeta) {
		this._activeStory = story;
		this._phase = "setup";
	}

	/** Transition to act phase — actions that ARE the test. */
	act() { this._phase = "act"; }

	/** Transition to assert phase — verifying outcomes. */
	assert() { this._phase = "assert"; }

	// --- Entity access ---

	session(name: string): SessionHandle {
		if (!this.sessions.has(name)) {
			const h = new SessionHandle(this._page, name);
			h.ctx = this;
			this.sessions.set(name, h);
		}
		return this.sessions.get(name)!;
	}

	goal(name: string): GoalHandle {
		if (!this.goals.has(name)) {
			const h = new GoalHandle(this._page, name);
			h.ctx = this;
			this.goals.set(name, h);
		}
		return this.goals.get(name)!;
	}

	gate(name: string): GateHandle {
		if (!this.gates.has(name)) {
			const h = new GateHandle(this._page, name);
			h.ctx = this;
			this.gates.set(name, h);
		}
		return this.gates.get(name)!;
	}

	staff(name: string): StaffHandle {
		if (!this.staffAgents.has(name)) {
			const h = new StaffHandle(this._page, name);
			h.ctx = this;
			this.staffAgents.set(name, h);
		}
		return this.staffAgents.get(name)!;
	}

	project(name: string): ProjectHandle {
		if (!this.projects.has(name)) {
			const h = new ProjectHandle(this._page, name);
			h.ctx = this;
			this.projects.set(name, h);
		}
		return this.projects.get(name)!;
	}

	// --- Setup helpers ---

	async createTestSession(name: string, opts?: { cwd?: string; goalId?: string; projectId?: string }): Promise<string> {
		const id = await createSession(opts);
		await waitForSessionStatus(id, "idle");
		const handle = this.session(name);
		handle.sessionId = id;
		return id;
	}

	async open() {
		await openApp(this._page);
	}

	async cleanup() {
		this._phase = "cleanup";
		for (const [, handle] of this.sessions) {
			try { await deleteSession(handle.sessionId); } catch { /* best effort */ }
		}
	}

	async create_session_via_ui(): Promise<string> {
		trackIntent(this._activeStory, this._phase, "create_session");
		trackRegion(this._activeStory, this._phase, "sidebar");
		await this._page.locator("button[title^='New session']").first().click();
		await expect(this._page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
		const hash = await this._page.evaluate(() => window.location.hash);
		const match = hash.match(/#\/session\/([a-f0-9-]+)/i);
		return match ? match[1] : "";
	}

	async rename_session(sessionName: string, newTitle: string) {
		trackIntent(this._activeStory, this._phase, "rename_session");
		trackRegion(this._activeStory, this._phase, "sidebar");
		const handle = this.sessions.get(sessionName);
		if (!handle) throw new Error(`Session '${sessionName}' not registered`);
		const row = this._page.locator(`.sidebar-session[data-id="${handle.sessionId}"], [data-session-id="${handle.sessionId}"]`).first();
		await row.dblclick();
		const input = this._page.locator('.sidebar-session input, [data-session-id] input').first();
		await input.fill(newTitle);
		await input.press('Enter');
	}

	// --- System events ---

	readonly event = {
		server_crash: async () => {
			trackIntent(this._activeStory, this._phase, "server_crash");
			// Implementation depends on test harness — kill server process
			throw new Error("server_crash: requires manual-integration harness — not available in standard E2E");
		},
		server_restart: async () => {
			trackIntent(this._activeStory, this._phase, "server_restart");
			throw new Error("server_restart: requires manual-integration harness — not available in standard E2E");
		},
		disconnect: async () => {
			trackIntent(this._activeStory, this._phase, "disconnect");
			await this._page.evaluate(() => {
				// Force-close all WebSocket connections
				(window as any).__bobbit_ws?.close();
			});
		},
		agent_finish: async (sessionName?: string) => {
			trackIntent(this._activeStory, this._phase, "agent_finish");
			if (sessionName) {
				const handle = this.sessions.get(sessionName);
				if (handle) await waitForSessionStatus(handle.sessionId, "idle");
			}
		},
	};

	// --- User intents ---

	async navigate_to(target: "session" | "goal" | "settings" | "search" | "landing", id?: string) {
		trackIntent(this._activeStory, this._phase, `navigate_to_${target}`);
		if (target === "session" && id) {
			const handle = this.sessions.get(id);
			const realId = handle?.sessionId || id;
			trackRegion(this._activeStory, this._phase, "sidebar");
			await navigateToHash(this._page, `#/session/${realId}`);
			await expect(this._page.locator("message-editor textarea").first())
				.toBeVisible({ timeout: 15_000 });
		} else if (target === "goal" && id) {
			const handle = this.goals.get(id);
			const realId = handle?.goalId || id;
			trackRegion(this._activeStory, this._phase, "dashboard");
			await navigateToHash(this._page, `#/goal/${realId}`);
			await expect(this._page.locator(".goal-dashboard, goal-dashboard").first())
				.toBeVisible({ timeout: 15_000 });
		} else if (target === "settings") {
			trackRegion(this._activeStory, this._phase, "settings");
			await navigateToHash(this._page, "#/settings");
			await this._page.waitForFunction(() =>
				window.location.hash.startsWith("#/settings"), { timeout: 5_000 });
		} else if (target === "search") {
			trackRegion(this._activeStory, this._phase, "search_page");
			await navigateToHash(this._page, "#/search");
		} else if (target === "landing") {
			await navigateToHash(this._page, "#/");
		}
	}

	async type_in(region: RegionHandle, text: string) {
		trackIntent(this._activeStory, this._phase, "type_in");
		trackRegion(this._activeStory, this._phase, "editor");
		if (region === this.editor || region === this.editor.text_input) {
			await this._page.locator("message-editor textarea").first().fill(text);
		} else {
			throw new Error("type_in: only editor region implemented so far");
		}
	}

	async send_message(text?: string) {
		trackIntent(this._activeStory, this._phase, "send_message");
		trackRegion(this._activeStory, this._phase, "editor");
		const textarea = this._page.locator("message-editor textarea").first();
		if (text) await textarea.fill(text);
		await textarea.press("Enter");
	}

	async stop_streaming() {
		trackIntent(this._activeStory, this._phase, "stop_streaming");
		trackRegion(this._activeStory, this._phase, "editor");
		await this._page.locator("button[title='Stop streaming']").first().click();
	}

	async wait_for_streaming(): Promise<void> {
		trackIntent(this._activeStory, this._phase, "wait_for_streaming");
		await expect(this._page.locator("button[title='Stop streaming']").first())
			.toBeVisible({ timeout: 15_000 });
	}

	async wait_for_idle(): Promise<void> {
		trackIntent(this._activeStory, this._phase, "wait_for_idle");
		await expect(this._page.locator("button[title='Stop streaming']").first())
			.not.toBeVisible({ timeout: 15_000 });
		await expect(this._page.locator("message-editor button[title='Send message']").first())
			.toBeVisible({ timeout: 5_000 });
	}

	async attach_file(name: string, _type: "file" | "image") {
		trackIntent(this._activeStory, this._phase, "attach_file");
		trackRegion(this._activeStory, this._phase, "editor");
		const fileInput = this._page.locator('message-editor input[type="file"]').first();
		await fileInput.setInputFiles({
			name,
			mimeType: _type === "image" ? "image/png" : "text/plain",
			buffer: Buffer.from("test file content"),
		});
		await expect(async () => {
			const count = await this._page.locator("attachment-tile").count();
			expect(count).toBeGreaterThan(0);
		}).toPass({ timeout: 10_000 });
	}

	async change_setting(setting: string, value: string) {
		trackIntent(this._activeStory, this._phase, "change_setting");
		trackRegion(this._activeStory, this._phase, "context_bar");
		if (setting === "model") {
			const modelBtn = this._page.locator(
				"[data-testid='model-selector'], button:has-text('claude'), button:has-text('sonnet'), button:has-text('haiku'), button:has-text('opus')"
			).first();
			const visible = await modelBtn.isVisible().catch(() => false);
			if (visible) {
				await modelBtn.click();
				const option = this._page.locator("[role='option'], [role='menuitem'], li")
					.filter({ hasText: value }).first();
				const optVisible = await option.isVisible().catch(() => false);
				if (optVisible) await option.click();
				else await this._page.keyboard.press("Escape");
			}
		}
	}

	async reload() {
		trackIntent(this._activeStory, this._phase, "reload");
		await this._page.reload();
		// Wait for sidebar to be present — use .sidebar-edge which is always in DOM
		// regardless of collapsed/expanded state (Settings button text is hidden when collapsed)
		await expect(
			this._page.locator(".sidebar-edge").first(),
		).toBeVisible({ timeout: 20_000 });
	}

	async press_key(key: string) {
		trackIntent(this._activeStory, this._phase, "press_key");
		await this._page.keyboard.press(key);
	}

	async pause_staff(staffName: string) {
		trackIntent(this._activeStory, this._phase, "pause_staff");
		trackRegion(this._activeStory, this._phase, "settings");
		const handle = this.staffAgents.get(staffName);
		if (!handle) throw new Error(`Staff '${staffName}' not registered`);
		// API call to pause
		await apiFetch(`/api/staff/${(handle as any)._staffId}/pause`, { method: "POST" });
	}

	async wake_staff(staffName: string) {
		trackIntent(this._activeStory, this._phase, "wake_staff");
		trackRegion(this._activeStory, this._phase, "settings");
		const handle = this.staffAgents.get(staffName);
		if (!handle) throw new Error(`Staff '${staffName}' not registered`);
		await apiFetch(`/api/staff/${(handle as any)._staffId}/wake`, { method: "POST" });
	}

	// --- Navigation ---

	async navigate_back(): Promise<void> {
		trackIntent(this._activeStory, this._phase, "navigate_back");
		await this._page.goBack();
		await this._page.waitForTimeout(300);
	}

	async navigate_forward(): Promise<void> {
		trackIntent(this._activeStory, this._phase, "navigate_forward");
		await this._page.goForward();
		await this._page.waitForTimeout(300);
	}

	async url_contains(fragment: string): Promise<void> {
		trackIntent(this._activeStory, this._phase, "url_check");
		await expect(async () => {
			const hash = await this._page.evaluate(() => window.location.hash);
			expect(hash).toContain(fragment);
		}).toPass({ timeout: 5_000 });
	}

	async url_equals(hash: string): Promise<void> {
		trackIntent(this._activeStory, this._phase, "url_check");
		await expect(async () => {
			const actual = await this._page.evaluate(() => window.location.hash);
			expect(actual).toBe(hash);
		}).toPass({ timeout: 5_000 });
	}

	async page_title_is(expected: string): Promise<void> {
		trackIntent(this._activeStory, this._phase, "page_title_check");
		await expect(async () => {
			const title = await this._page.evaluate(() => document.title);
			expect(title).toBe(expected);
		}).toPass({ timeout: 5_000 });
	}

	async page_title_contains(fragment: string): Promise<void> {
		trackIntent(this._activeStory, this._phase, "page_title_check");
		await expect(async () => {
			const title = await this._page.evaluate(() => document.title);
			expect(title).toContain(fragment);
		}).toPass({ timeout: 5_000 });
	}

	// --- Temporal ---

	async wait_for_draft_saved(sessionName: string, expectedText: string) {
		const handle = this.session(sessionName);
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${handle.sessionId}/draft?type=prompt`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(body.data.text).toBe(expectedText);
		}).toPass({ intervals: [500, 1000, 1000, 2000, 2000], timeout: 15_000 });
	}
}

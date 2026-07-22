/**
 * Agent-finish beep preference — shared read/write helpers.
 *
 * The global preference lives server-side (`playAgentFinishSound`) and is
 * mirrored onto `document.documentElement.dataset.playAgentFinishSound`
 * (default ON; only an explicit `false` opts out). The global helpers remain the
 * single place that flips it, so the header `<bell-toggle>` and global Settings
 * checkbox stay consistent. Project overrides are resolved separately below.
 */
// Import from the dependency-free module (not ./api.js) so this helper — and
// the <bell-toggle> that imports it — don't drag the whole app-shell graph.
import { gatewayFetch } from "./gateway-fetch.js";

/** Raw project-config key for an explicit agent-finish beep override. */
export const PROJECT_PLAY_FINISH_SOUND_KEY = "play_agent_finish_sound";

export type ProjectPlayFinishSoundOverride = "inherit" | "on" | "off";

export interface FinishSoundSource {
	projectId?: string | null;
}

interface PendingProjectSoundMutation {
	id: number;
	value: ProjectPlayFinishSoundOverride;
}

type ProjectLoadResult = "accepted" | "stale" | "failed";

/** Server-confirmed values. An explicit `inherit` is a loaded baseline. */
const projectConfirmedOverrides = new Map<string, ProjectPlayFinishSoundOverride>();
/** Optimistic choices in enqueue order. The newest entry owns visibility. */
const projectPendingMutations = new Map<string, PendingProjectSoundMutation[]>();
/** Requests only live here while their raw-config GET is in flight. */
const projectLoads = new Map<string, Promise<ProjectLoadResult>>();
/** Monotonic authority used to reject raw reads that raced a mutation/read. */
const projectRevisions = new Map<string, number>();
const projectNextMutationIds = new Map<string, number>();
/** A non-rejecting tail keeps each project's PUT transport strictly ordered. */
const projectWriteTails = new Map<string, Promise<void>>();

function normalizeProjectId(projectId: string | null | undefined): string {
	return typeof projectId === "string" ? projectId.trim() : "";
}

function currentProjectRevision(projectId: string): number {
	return projectRevisions.get(projectId) ?? 0;
}

function advanceProjectRevision(projectId: string): void {
	projectRevisions.set(projectId, currentProjectRevision(projectId) + 1);
}

function parseProjectOverride(rawValue: unknown): ProjectPlayFinishSoundOverride {
	if (rawValue === "true") return "on";
	if (rawValue === "false") return "off";
	return "inherit";
}

function isProjectOverride(value: unknown): value is ProjectPlayFinishSoundOverride {
	return value === "inherit" || value === "on" || value === "off";
}

function visibleProjectOverride(projectId: string): ProjectPlayFinishSoundOverride | undefined {
	const pending = projectPendingMutations.get(projectId);
	if (pending?.length) return pending[pending.length - 1].value;
	return projectConfirmedOverrides.get(projectId);
}

/** Window event dispatched whenever the beep preference changes (any surface). */
export const PLAY_FINISH_SOUND_CHANGED = "bobbit-play-finish-sound-changed";

/** Current effective state — default ON; only an explicit `false` opts out. */
export function isPlayFinishSoundEnabled(): boolean {
	if (typeof document === "undefined") return true;
	return document.documentElement.dataset.playAgentFinishSound !== "false";
}

/**
 * Flip + persist the beep preference. Applies the dataset synchronously (so the
 * `playNotificationBeep()` gate flips immediately, without waiting on the
 * `preferences_changed` broadcast), notifies in-page listeners, then persists.
 */
export async function setPlayFinishSoundEnabled(enabled: boolean): Promise<void> {
	if (typeof document !== "undefined") {
		document.documentElement.dataset.playAgentFinishSound = enabled ? "true" : "false";
	}
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent(PLAY_FINISH_SOUND_CHANGED, { detail: { enabled } }));
	}
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ playAgentFinishSound: enabled }),
		});
	} catch {
		// Non-fatal — the dataset is already applied optimistically.
	}
}

/**
 * Newest pending project choice, otherwise the last server-confirmed baseline.
 * `undefined` means this project has neither and still needs a raw-config load.
 */
export function getProjectPlayFinishSoundOverride(
	projectId: string,
): ProjectPlayFinishSoundOverride | undefined {
	const id = normalizeProjectId(projectId);
	return id ? visibleProjectOverride(id) : undefined;
}

/** Whether a raw GET or successful PUT has established an authoritative baseline. */
export function isProjectPlayFinishSoundOverrideLoaded(projectId: string): boolean {
	const id = normalizeProjectId(projectId);
	return id ? projectConfirmedOverrides.has(id) : false;
}

/** Capture this immediately before starting a raw project-config GET. */
export function captureProjectPlayFinishSoundRead(projectId: string): number {
	const id = normalizeProjectId(projectId);
	return id ? currentProjectRevision(id) : 0;
}

/**
 * Establish a raw-read baseline only when no enqueue, settlement, or accepted
 * competing read has invalidated it. Missing and malformed values inherit.
 */
export function primeProjectPlayFinishSoundOverride(
	projectId: string,
	rawValue: unknown,
	capturedRevision: number,
): boolean {
	const id = normalizeProjectId(projectId);
	if (!id || currentProjectRevision(id) !== capturedRevision) return false;
	if (projectPendingMutations.get(id)?.length) return false;

	projectConfirmedOverrides.set(id, parseProjectOverride(rawValue));
	advanceProjectRevision(id);
	return true;
}

function rawProjectOverride(config: unknown): unknown {
	if (config === null || typeof config !== "object") return undefined;
	return (config as Record<string, unknown>)[PROJECT_PLAY_FINISH_SOUND_KEY];
}

function startProjectOverrideLoad(projectId: string): Promise<ProjectLoadResult> {
	const capturedRevision = captureProjectPlayFinishSoundRead(projectId);
	const request = (async (): Promise<ProjectLoadResult> => {
		try {
			const response = await gatewayFetch(
				`/api/projects/${encodeURIComponent(projectId)}/config`,
			);
			if (!response.ok) return "failed";
			const config: unknown = await response.json();
			return primeProjectPlayFinishSoundOverride(
				projectId,
				rawProjectOverride(config),
				capturedRevision,
			)
				? "accepted"
				: "stale";
		} catch {
			return "failed";
		}
	})();

	// Store the promise whose finally callback performs cleanup so every caller
	// observes the exact same in-flight request. The request never rejects.
	let load: Promise<ProjectLoadResult>;
	load = request.finally(() => {
		if (projectLoads.get(projectId) === load) projectLoads.delete(projectId);
	});
	projectLoads.set(projectId, load);
	return load;
}

/**
 * Ensure one project's raw override is available. Failures are consumed and
 * remain retryable; a stale read retries only when no concurrent value exists.
 */
export async function ensureProjectPlayFinishSoundOverride(projectId: string): Promise<boolean> {
	const id = normalizeProjectId(projectId);
	if (!id) return false;

	for (;;) {
		if (visibleProjectOverride(id) !== undefined) return true;

		const outcome = await (projectLoads.get(id) ?? startProjectOverrideLoad(id));
		if (visibleProjectOverride(id) !== undefined) return true;
		if (outcome === "failed") return false;
		// A stale read with no pending/confirmed value must retry at the new
		// revision. An accepted read always established a visible baseline.
	}
}

/** Explicit source-project override, then the current global setting. */
export async function isEffectivePlayFinishSoundEnabled(
	source?: FinishSoundSource,
): Promise<boolean> {
	const projectId = normalizeProjectId(source?.projectId);
	if (!projectId) return isPlayFinishSoundEnabled();

	let override = visibleProjectOverride(projectId);
	while (override === undefined) {
		const available = await ensureProjectPlayFinishSoundOverride(projectId);
		override = visibleProjectOverride(projectId);
		if (override === undefined && !available) return isPlayFinishSoundEnabled();
		// A cold pending mutation may have failed between ensure's availability
		// check and this continuation. Retry its raw baseline instead of treating
		// that transient optimistic value as a failed project lookup.
	}

	if (override === "on") return true;
	if (override === "off") return false;
	return isPlayFinishSoundEnabled();
}

function nextProjectMutationId(projectId: string): number {
	const id = (projectNextMutationIds.get(projectId) ?? 0) + 1;
	projectNextMutationIds.set(projectId, id);
	return id;
}

function removeProjectMutation(projectId: string, mutationId: number): void {
	const pending = projectPendingMutations.get(projectId);
	if (pending) {
		const index = pending.findIndex((mutation) => mutation.id === mutationId);
		if (index >= 0) pending.splice(index, 1);
		if (pending.length === 0) projectPendingMutations.delete(projectId);
	}
	advanceProjectRevision(projectId);
}

async function persistProjectOverrideMutation(
	projectId: string,
	mutation: PendingProjectSoundMutation,
): Promise<boolean> {
	let succeeded = false;
	try {
		const persistedValue = mutation.value === "inherit"
			? null
			: mutation.value === "on" ? "true" : "false";
		const response = await gatewayFetch(
			`/api/projects/${encodeURIComponent(projectId)}/config`,
			{
				method: "PUT",
				body: JSON.stringify({ [PROJECT_PLAY_FINISH_SOUND_KEY]: persistedValue }),
			},
		);
		succeeded = response.ok;
	} catch {
		succeeded = false;
	} finally {
		if (succeeded) projectConfirmedOverrides.set(projectId, mutation.value);
		removeProjectMutation(projectId, mutation.id);
	}
	return succeeded;
}

/**
 * Make a project choice visible immediately, then persist PUTs serially for
 * that project. Each returned promise reports only its own request's outcome.
 */
export function setProjectPlayFinishSoundOverride(
	projectId: string,
	override: ProjectPlayFinishSoundOverride,
): Promise<boolean> {
	const id = normalizeProjectId(projectId);
	if (!id || !isProjectOverride(override)) return Promise.resolve(false);

	const mutation: PendingProjectSoundMutation = {
		id: nextProjectMutationId(id),
		value: override,
	};
	const pending = projectPendingMutations.get(id);
	if (pending) pending.push(mutation);
	else projectPendingMutations.set(id, [mutation]);
	advanceProjectRevision(id);

	const priorTail = projectWriteTails.get(id) ?? Promise.resolve();
	const result = priorTail.then(() => persistProjectOverrideMutation(id, mutation));
	// Consume the boolean result into a non-rejecting tail. The persistence
	// helper catches transport failures, so fire-and-forget callers are safe.
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	projectWriteTails.set(id, tail);
	void tail.then(() => {
		if (projectWriteTails.get(id) === tail) projectWriteTails.delete(id);
	});
	return result;
}

/** Minimal state visibility for deterministic concurrency tests. */
export const __test = {
	resetProjectOverrides(): void {
		projectConfirmedOverrides.clear();
		projectPendingMutations.clear();
		projectLoads.clear();
		projectRevisions.clear();
		projectNextMutationIds.clear();
		projectWriteTails.clear();
	},
	getProjectState(projectId: string): {
		confirmed: ProjectPlayFinishSoundOverride | undefined;
		pending: ProjectPlayFinishSoundOverride[];
		revision: number;
		loading: boolean;
		writing: boolean;
	} {
		const id = normalizeProjectId(projectId);
		return {
			confirmed: id ? projectConfirmedOverrides.get(id) : undefined,
			pending: id
				? (projectPendingMutations.get(id) ?? []).map((mutation) => mutation.value)
				: [],
			revision: id ? currentProjectRevision(id) : 0,
			loading: id ? projectLoads.has(id) : false,
			writing: id ? projectWriteTails.has(id) : false,
		};
	},
};

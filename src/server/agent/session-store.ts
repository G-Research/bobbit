import fs from "node:fs";
import path from "node:path";
import type { QueuedMessage } from "../ws/protocol.js";
import { bobbitStateDir } from "../bobbit-dir.js";

/** Persisted metadata for a single gateway session */
export interface PersistedSession {
	id: string;
	title: string;
	cwd: string;
	/** The agent's .jsonl session file path — needed to resume */
	agentSessionFile: string;
	createdAt: number;
	lastActivity: number;
	/** Optional goal this session belongs to */
	goalId?: string;
	/** Whether the agent was actively streaming when the server last knew about it */
	wasStreaming?: boolean;
	/** Epoch ms when the current streaming turn started (survives server restarts) */
	streamingStartedAt?: number;
	/** If this session is a delegate, the parent session ID */
	delegateOf?: string;
	/** Role in a team goal (e.g., 'coder', 'reviewer', 'tester') */
	role?: string;
	/** The team goal this agent belongs to */
	teamGoalId?: string;
	/** Path to the git worktree for this session */
	worktreePath?: string;
	/** Assistant type: "goal" | "role" | "tool" */
	assistantType?: string;
	// Legacy boolean fields — kept for backward compat during migration
	/** @deprecated Use assistantType instead */
	goalAssistant?: boolean;
	/** @deprecated Use assistantType instead */
	roleAssistant?: boolean;
	/** @deprecated Use assistantType instead */
	toolAssistant?: boolean;
	/** Task ID this session is working on */
	taskId?: string;
	/** Staff agent ID this session belongs to */
	staffId?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
	/** Personality names */
	personalities?: string[];
	/** Persisted prompt queue */
	messageQueue?: QueuedMessage[];
}

const STORE_DIR = bobbitStateDir();
const STORE_FILE = path.join(STORE_DIR, "sessions.json");

/**
 * Simple JSON file store for gateway session metadata.
 * Allows sessions to survive server restarts.
 */
export class SessionStore {
	private sessions: Map<string, PersistedSession> = new Map();
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private static SAVE_DEBOUNCE_MS = 1000;

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const s of data) {
						if (s.id && s.agentSessionFile) {
							// Migrate legacy 'swarmGoalId' field to 'teamGoalId'
							if (s.swarmGoalId !== undefined && s.teamGoalId === undefined) {
								s.teamGoalId = s.swarmGoalId;
								delete s.swarmGoalId;
							}
							// Normalize legacy boolean flags to assistantType
							if (!s.assistantType) {
								if (s.goalAssistant) s.assistantType = "goal";
								else if (s.roleAssistant) s.assistantType = "role";
								else if (s.toolAssistant) s.assistantType = "tool";
							}
							this.sessions.set(s.id, s);
						}
					}
				}
			}
		} catch (err) {
			console.error("[session-store] Failed to load persisted sessions:", err);
		}
	}

	/** Write sessions to disk immediately (synchronous). */
	private saveNow(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.sessions.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[session-store] Failed to save sessions:", err);
		}
	}

	/** Schedule a debounced save — coalesces rapid writes into one disk flush. */
	private save(): void {
		if (this.saveTimer) return; // already scheduled
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, SessionStore.SAVE_DEBOUNCE_MS);
	}

	put(session: PersistedSession): void {
		this.sessions.set(session.id, session);
		this.saveNow(); // immediate — structural change
	}

	get(id: string): PersistedSession | undefined {
		return this.sessions.get(id);
	}

	remove(id: string): void {
		this.sessions.delete(id);
		this.saveNow(); // immediate — structural change
	}

	getAll(): PersistedSession[] {
		return Array.from(this.sessions.values());
	}

	/** Update a subset of fields for an existing session */
	update(id: string, updates: Partial<Pick<PersistedSession, "title" | "lastActivity" | "agentSessionFile" | "goalId" | "wasStreaming" | "streamingStartedAt" | "delegateOf" | "role" | "teamGoalId" | "worktreePath" | "assistantType" | "goalAssistant" | "roleAssistant" | "toolAssistant" | "taskId" | "staffId" | "accessory" | "preview" | "personalities" | "messageQueue">>): void {
		const existing = this.sessions.get(id);
		if (!existing) return;
		Object.assign(existing, updates);
		this.save(); // debounced — frequent field updates
	}

	/** Flush any pending debounced save immediately (e.g. before shutdown). */
	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			this.saveNow();
		}
	}
}

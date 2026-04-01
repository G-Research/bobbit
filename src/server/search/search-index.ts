import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { extractTextFromMessage } from "./message-extractor.js";
import type { PersistedGoal, GoalStore } from "../agent/goal-store.js";
import type { PersistedSession, SessionStore } from "../agent/session-store.js";
import type { PersistedStaff } from "../agent/staff-store.js";
import type { StaffStore } from "../agent/staff-store.js";

const SCHEMA_VERSION = 3;

// ── Public interfaces ────────────────────────────────────────────────

export interface SearchResult {
	type: "goal" | "session" | "message" | "staff";
	/** goalId for goals, sessionId for sessions, FTS5 rowid string for messages */
	id: string;
	title: string;
	/** FTS5 snippet() with <b> match highlighting */
	snippet: string;
	timestamp: number;
	archived: boolean;
	goalId?: string;
	sessionId?: string;
	sessionTitle?: string;
	projectId?: string;
	projectName?: string;
}

export interface SearchResults {
	results: SearchResult[];
	total: number;
}

// ── SearchIndex ──────────────────────────────────────────────────────

export class SearchIndex {
	private db: Database.Database | null = null;
	private readonly dbPath: string;
	private _needsRebuild = false;

	/** Optional staff store — set before open()/rebuild to include staff in the index. */
	staffStore?: StaffStore;

	// Prepared statements (lazily created after open)
	private stmts: {
		deleteGoal: Database.Statement;
		insertGoal: Database.Statement;
		deleteSession: Database.Statement;
		insertSession: Database.Statement;
		insertMessage: Database.Statement;
		deleteMessagesBySession: Database.Statement;
		deleteStaff: Database.Statement;
		insertStaff: Database.Statement;
	} | null = null;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	// ── Lifecycle ──────────────────────────────────────────────────

	open(): void {
		const dir = path.dirname(this.dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(this.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");

		// Check if rebuild is needed BEFORE ensureSchema creates tables
		this._needsRebuild = this.checkNeedsRebuild();

		this.ensureSchema();
		this.prepareStatements();
	}

	close(): void {
		this.stmts = null;
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	/**
	 * Returns true if the index needs a full rebuild.
	 * The flag is set during open() BEFORE ensureSchema() creates the tables.
	 */
	needsRebuild(): boolean {
		return this._needsRebuild;
	}

	/** Pre-ensureSchema check: is the DB fresh or version mismatched? */
	private checkNeedsRebuild(): boolean {
		if (!this.db) return true;
		try {
			const row = this.db
				.prepare("SELECT version FROM schema_version LIMIT 1")
				.get() as { version: number } | undefined;
			return !row || row.version !== SCHEMA_VERSION;
		} catch {
			// Table doesn't exist
			return true;
		}
	}

	// ── Goal indexing ──────────────────────────────────────────────

	indexGoal(goal: PersistedGoal, projectId?: string): void {
		if (!this.stmts) return;
		this.stmts.deleteGoal.run(goal.id);
		this.stmts.insertGoal.run(
			goal.id,
			goal.title || "",
			goal.spec || "",
			goal.state || "",
			goal.archived ? "1" : "0",
			goal.createdAt ?? 0,
			goal.archivedAt ?? 0,
			projectId ?? goal.projectId ?? "",
		);
	}

	removeGoal(goalId: string): void {
		this.stmts?.deleteGoal.run(goalId);
	}

	// ── Session indexing ───────────────────────────────────────────

	indexSession(session: PersistedSession, goalTitle?: string, projectId?: string): void {
		if (!this.stmts) return;
		this.stmts.deleteSession.run(session.id);
		this.stmts.insertSession.run(
			session.id,
			session.title || "",
			session.role || "",
			session.goalId || "",
			goalTitle || "",
			session.archived ? "1" : "0",
			session.createdAt ?? 0,
			session.archivedAt ?? 0,
			projectId ?? session.projectId ?? "",
		);
	}

	removeSession(sessionId: string): void {
		this.stmts?.deleteSession.run(sessionId);
	}

	// ── Message indexing ───────────────────────────────────────────

	indexMessage(
		sessionId: string,
		sessionTitle: string,
		text: string,
		toolNames: string[],
		timestamp: number,
		projectId?: string,
	): void {
		if (!this.stmts || !text.trim()) return;
		this.stmts.insertMessage.run(
			sessionId,
			sessionTitle,
			text,
			toolNames.join(" "),
			timestamp,
			projectId ?? "",
		);
	}

	removeMessagesForSession(sessionId: string): void {
		this.stmts?.deleteMessagesBySession.run(sessionId);
	}

	// ── Staff indexing ─────────────────────────────────────────────

	indexStaff(staff: PersistedStaff, projectId?: string): void {
		if (!this.stmts) return;
		this.stmts.deleteStaff.run(staff.id);
		this.stmts.insertStaff.run(staff.id, staff.name || "", staff.description || "", staff.state || "", staff.createdAt ?? 0, projectId ?? "");
	}

	removeStaff(staffId: string): void {
		this.stmts?.deleteStaff.run(staffId);
	}

	// ── Full rebuild ───────────────────────────────────────────────

	rebuildFromStores(
		goalStore: GoalStore,
		sessionStore: SessionStore,
		_sessionsDir?: string,
		staffStore?: StaffStore,
	): void {
		if (!this.db) return;

		// Use explicit param or fallback to instance property
		const effectiveStaffStore = staffStore || this.staffStore;

		// Build a goalId → title map for session indexing
		const goals = goalStore.getAll();
		const goalTitleMap = new Map<string, string>();
		for (const g of goals) {
			goalTitleMap.set(g.id, g.title);
		}

		const sessions = sessionStore.getAll();
		const staffEntries = effectiveStaffStore ? effectiveStaffStore.getAll() : [];
		let messageCount = 0;

		console.log(
			`[search] Rebuilding index: ${goals.length} goals, ${sessions.length} sessions, ${staffEntries.length} staff...`,
		);

		const rebuild = this.db.transaction(() => {
			// Clear everything
			this.db!.exec("DELETE FROM goals_fts");
			this.db!.exec("DELETE FROM sessions_fts");
			this.db!.exec("DELETE FROM messages_fts");
			this.db!.exec("DELETE FROM staff_fts");

			// Index goals
			for (const goal of goals) {
				this.indexGoal(goal, goal.projectId ?? "");
			}

			// Index sessions
			for (const session of sessions) {
				const goalTitle = session.goalId
					? goalTitleMap.get(session.goalId) || ""
					: "";
				this.indexSession(session, goalTitle, session.projectId ?? "");
			}

			// Index messages from .jsonl files
			for (const session of sessions) {
				if (!session.agentSessionFile) continue;
				const jsonlPath = session.agentSessionFile;
				if (!fs.existsSync(jsonlPath)) continue;

				try {
					const content = fs.readFileSync(jsonlPath, "utf-8");
					const lines = content.split("\n");
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const entry = JSON.parse(line);
							// Agent session files contain message objects
							const msg = entry.message || entry;
							const { text, toolNames } = extractTextFromMessage(msg);
							if (text.trim()) {
								this.indexMessage(
									session.id,
									session.title || "",
									text,
									toolNames,
									msg.timestamp || session.lastActivity || 0,
									session.projectId ?? "",
								);
								messageCount++;
							}
						} catch {
							// Skip unparseable lines
						}
					}
				} catch {
					// Skip unreadable files
				}
			}

			// Index staff
			for (const staff of staffEntries) {
				this.indexStaff(staff, (staff as any).projectId);
			}
		});

		rebuild();
		this._needsRebuild = false;
		console.log(
			`[search] Index rebuilt: ${goals.length} goals, ${sessions.length} sessions, ${messageCount} messages, ${staffEntries.length} staff`,
		);
	}

	// ── Search ─────────────────────────────────────────────────────

	search(
		query: string,
		opts: {
			type?: "all" | "goals" | "sessions" | "messages" | "staff";
			limit?: number;
			offset?: number;
			projectId?: string;
			projectNames?: Map<string, string>;
		} = {},
	): SearchResults {
		if (!this.db || !query.trim()) {
			return { results: [], total: 0 };
		}

		const type = opts.type || "all";
		const limit = opts.limit ?? 20;
		const offset = opts.offset ?? 0;
		const projectId = opts.projectId;
		const projectNames = opts.projectNames;

		// Sanitise the query for FTS5: escape double quotes, wrap terms
		const ftsQuery = sanitiseFtsQuery(query);
		if (!ftsQuery) {
			return { results: [], total: 0 };
		}

		const results: SearchResult[] = [];
		let total = 0;

		if (type === "all" || type === "goals") {
			const { rows, count } = this.searchGoals(ftsQuery, type === "goals" ? limit : 10, type === "goals" ? offset : 0, projectId);
			results.push(...rows);
			total += count;
		}

		if (type === "all" || type === "sessions") {
			const { rows, count } = this.searchSessions(ftsQuery, type === "sessions" ? limit : 10, type === "sessions" ? offset : 0, projectId);
			results.push(...rows);
			total += count;
		}

		if (type === "all" || type === "messages") {
			const { rows, count } = this.searchMessages(ftsQuery, type === "messages" ? limit : 10, type === "messages" ? offset : 0, projectId);
			results.push(...rows);
			total += count;
		}

		if (type === "all" || type === "staff") {
			const { rows, count } = this.searchStaffEntries(ftsQuery, type === "staff" ? limit : 10, type === "staff" ? offset : 0, projectId);
			results.push(...rows);
			total += count;
		}

		// Populate projectName from the names map
		if (projectNames) {
			for (const r of results) {
				if (r.projectId) {
					r.projectName = projectNames.get(r.projectId);
				}
			}
		}

		// For type-specific queries, apply limit/offset at the top level
		if (type !== "all") {
			return { results, total };
		}

		// For "all", we already limited each type to 10
		return { results, total };
	}

	// ── Private helpers ────────────────────────────────────────────

	private ensureSchema(): void {
		if (!this.db) return;

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_version (version INTEGER);

			CREATE VIRTUAL TABLE IF NOT EXISTS goals_fts USING fts5(
				goal_id UNINDEXED, title, spec,
				state UNINDEXED, archived UNINDEXED,
				created_at UNINDEXED, archived_at UNINDEXED,
				project_id UNINDEXED
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
				session_id UNINDEXED, title, role,
				goal_id UNINDEXED, goal_title,
				archived UNINDEXED, created_at UNINDEXED, archived_at UNINDEXED,
				project_id UNINDEXED
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
				session_id UNINDEXED, session_title UNINDEXED,
				text_content, tool_names,
				timestamp UNINDEXED,
				project_id UNINDEXED
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS staff_fts USING fts5(
				staff_id UNINDEXED, name, description,
				state UNINDEXED, created_at UNINDEXED,
				project_id UNINDEXED
			);
		`);

		// Set version if not present
		const row = this.db
			.prepare("SELECT version FROM schema_version LIMIT 1")
			.get() as { version: number } | undefined;
		if (!row) {
			this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
		} else if (row.version !== SCHEMA_VERSION) {
			// Version mismatch — drop and recreate
			this.db.exec("DROP TABLE IF EXISTS goals_fts");
			this.db.exec("DROP TABLE IF EXISTS sessions_fts");
			this.db.exec("DROP TABLE IF EXISTS messages_fts");
			this.db.exec("DROP TABLE IF EXISTS staff_fts");
			this.db.exec("DROP TABLE IF EXISTS schema_version");
			// Recurse to recreate
			this.ensureSchema();
		}
	}

	private prepareStatements(): void {
		if (!this.db) return;

		this.stmts = {
			deleteGoal: this.db.prepare(
				"DELETE FROM goals_fts WHERE goal_id = ?",
			),
			insertGoal: this.db.prepare(
				"INSERT INTO goals_fts (goal_id, title, spec, state, archived, created_at, archived_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			),
			deleteSession: this.db.prepare(
				"DELETE FROM sessions_fts WHERE session_id = ?",
			),
			insertSession: this.db.prepare(
				"INSERT INTO sessions_fts (session_id, title, role, goal_id, goal_title, archived, created_at, archived_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			),
			insertMessage: this.db.prepare(
				"INSERT INTO messages_fts (session_id, session_title, text_content, tool_names, timestamp, project_id) VALUES (?, ?, ?, ?, ?, ?)",
			),
			deleteMessagesBySession: this.db.prepare(
				"DELETE FROM messages_fts WHERE session_id = ?",
			),
			deleteStaff: this.db.prepare(
				"DELETE FROM staff_fts WHERE staff_id = ?",
			),
			insertStaff: this.db.prepare(
				"INSERT INTO staff_fts (staff_id, name, description, state, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?)",
			),
		};
	}

	private searchGoals(
		ftsQuery: string,
		limit: number,
		offset: number,
		projectId?: string,
	): { rows: SearchResult[]; count: number } {
		if (!this.db) return { rows: [], count: 0 };

		try {
			const projectFilter = projectId ? " AND project_id = ?" : "";
			const params: unknown[] = [ftsQuery];
			if (projectId) params.push(projectId);

			const countRow = this.db.prepare(
				`SELECT count(*) as cnt FROM goals_fts WHERE goals_fts MATCH ?${projectFilter}`,
			).get(...params) as { cnt: number };
			const count = countRow?.cnt ?? 0;

			const rows = this.db.prepare(
				`SELECT goal_id, title, snippet(goals_fts, 2, '<b>', '</b>', '...', 40) as snippet,
					state, archived, created_at, archived_at, project_id
				 FROM goals_fts WHERE goals_fts MATCH ?${projectFilter}
				 ORDER BY rank
				 LIMIT ? OFFSET ?`,
			).all(...params, limit, offset) as Array<{
				goal_id: string;
				title: string;
				snippet: string;
				state: string;
				archived: string;
				created_at: number;
				archived_at: number;
				project_id: string;
			}>;

			return {
				count,
				rows: rows.map((r) => ({
					type: "goal" as const,
					id: r.goal_id,
					title: r.title,
					snippet: r.snippet,
					timestamp: Number(r.created_at) || 0,
					archived: r.archived === "1",
					projectId: r.project_id || undefined,
				})),
			};
		} catch {
			return { rows: [], count: 0 };
		}
	}

	private searchSessions(
		ftsQuery: string,
		limit: number,
		offset: number,
		projectId?: string,
	): { rows: SearchResult[]; count: number } {
		if (!this.db) return { rows: [], count: 0 };

		try {
			const projectFilter = projectId ? " AND project_id = ?" : "";
			const params: unknown[] = [ftsQuery];
			if (projectId) params.push(projectId);

			const countRow = this.db.prepare(
				`SELECT count(*) as cnt FROM sessions_fts WHERE sessions_fts MATCH ?${projectFilter}`,
			).get(...params) as { cnt: number };
			const count = countRow?.cnt ?? 0;

			const rows = this.db.prepare(
				`SELECT session_id, title, snippet(sessions_fts, 1, '<b>', '</b>', '...', 40) as snippet,
					goal_id, archived, created_at, archived_at, project_id
				 FROM sessions_fts WHERE sessions_fts MATCH ?${projectFilter}
				 ORDER BY rank
				 LIMIT ? OFFSET ?`,
			).all(...params, limit, offset) as Array<{
				session_id: string;
				title: string;
				snippet: string;
				goal_id: string;
				archived: string;
				created_at: number;
				archived_at: number;
				project_id: string;
			}>;

			return {
				count,
				rows: rows.map((r) => ({
					type: "session" as const,
					id: r.session_id,
					title: r.title,
					snippet: r.snippet,
					timestamp: Number(r.created_at) || 0,
					archived: r.archived === "1",
					goalId: r.goal_id || undefined,
					projectId: r.project_id || undefined,
				})),
			};
		} catch {
			return { rows: [], count: 0 };
		}
	}

	private searchMessages(
		ftsQuery: string,
		limit: number,
		offset: number,
		projectId?: string,
	): { rows: SearchResult[]; count: number } {
		if (!this.db) return { rows: [], count: 0 };

		try {
			const projectFilter = projectId ? " AND project_id = ?" : "";
			const params: unknown[] = [ftsQuery];
			if (projectId) params.push(projectId);

			const countRow = this.db.prepare(
				`SELECT count(*) as cnt FROM messages_fts WHERE messages_fts MATCH ?${projectFilter}`,
			).get(...params) as { cnt: number };
			const count = countRow?.cnt ?? 0;

			const rows = this.db.prepare(
				`SELECT rowid, session_id, session_title,
					snippet(messages_fts, 2, '<b>', '</b>', '...', 40) as snippet,
					timestamp, project_id
				 FROM messages_fts WHERE messages_fts MATCH ?${projectFilter}
				 ORDER BY rank
				 LIMIT ? OFFSET ?`,
			).all(...params, limit, offset) as Array<{
				rowid: number;
				session_id: string;
				session_title: string;
				snippet: string;
				timestamp: number;
				project_id: string;
			}>;

			return {
				count,
				rows: rows.map((r) => ({
					type: "message" as const,
					id: String(r.rowid),
					title: r.session_title || "Untitled session",
					snippet: r.snippet,
					timestamp: Number(r.timestamp) || 0,
					archived: false,
					sessionId: r.session_id,
					sessionTitle: r.session_title || undefined,
					projectId: r.project_id || undefined,
				})),
			};
		} catch {
			return { rows: [], count: 0 };
		}
	}

	private searchStaffEntries(
		ftsQuery: string,
		limit: number,
		offset: number,
		projectId?: string,
	): { rows: SearchResult[]; count: number } {
		if (!this.db) return { rows: [], count: 0 };

		try {
			const projectFilter = projectId ? " AND project_id = ?" : "";
			const params: unknown[] = [ftsQuery];
			if (projectId) params.push(projectId);

			const countRow = this.db.prepare(
				`SELECT count(*) as cnt FROM staff_fts WHERE staff_fts MATCH ?${projectFilter}`,
			).get(...params) as { cnt: number };
			const count = countRow?.cnt ?? 0;

			const rows = this.db.prepare(
				`SELECT staff_id, name, snippet(staff_fts, 2, '<b>', '</b>', '...', 40) as snippet,
					state, created_at, project_id
				 FROM staff_fts WHERE staff_fts MATCH ?${projectFilter}
				 ORDER BY rank
				 LIMIT ? OFFSET ?`,
			).all(...params, limit, offset) as Array<{
				staff_id: string;
				name: string;
				snippet: string;
				state: string;
				created_at: number;
				project_id: string;
			}>;

			return {
				count,
				rows: rows.map((r) => ({
					type: "staff" as const,
					id: r.staff_id,
					title: r.name,
					snippet: r.snippet,
					timestamp: Number(r.created_at) || 0,
					archived: false,
					projectId: r.project_id || undefined,
				})),
			};
		} catch {
			return { rows: [], count: 0 };
		}
	}
}

// ── FTS5 query sanitiser ─────────────────────────────────────────────

/**
 * Sanitise a user query string for FTS5 MATCH.
 * Wraps each token in double quotes to prevent FTS5 syntax errors
 * from special characters (colons, hyphens, etc.).
 */
function sanitiseFtsQuery(raw: string): string {
	// Strip characters that break FTS5 even inside quotes
	const cleaned = raw.replace(/["\u201C\u201D]/g, " ").trim();
	if (!cleaned) return "";

	// Split into tokens and wrap each in double quotes
	const tokens = cleaned.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "";

	// Last token gets prefix matching (unquoted with *) so partial words work
	// e.g. "sandb" → matches "sandbox". Earlier tokens are exact-quoted.
	// Strip FTS5 special chars from the prefix token since it's unquoted.
	return tokens.map((t, i) => {
		if (i === tokens.length - 1) {
			const safe = t.replace(/[^a-zA-Z0-9_]/g, "");
			return safe ? `${safe}*` : `"${t}"`;
		}
		return `"${t}"`;
	}).join(" ");
}

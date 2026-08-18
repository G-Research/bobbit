/**
 * SecretsStore — persists secret values in the state directory (gitignored).
 * Separate from project.yaml (config dir) so secrets never appear in git diffs.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";

/** A redacted, actionable error for callers that persist sandbox token values. */
export class SecretsStorePersistenceError extends Error {
    readonly code = "SANDBOX_SECRET_PERSIST_FAILED";

    constructor() {
        super("Sandbox secret values could not be saved. Check the project state directory permissions and retry.");
        this.name = "SecretsStorePersistenceError";
    }
}

export class SecretsStore {
    private data: Record<string, string> = {};
    private readonly filePath: string;
    private readonly fs: FsLike;

    constructor(stateDir: string, fsImpl: FsLike = realFs) {
        this.fs = fsImpl;
        this.filePath = path.join(stateDir, "secrets.json");
        this.load();
    }

    private load(): void {
        try {
            if (this.fs.existsSync(this.filePath)) {
                const raw = JSON.parse(this.fs.readFileSync(this.filePath, "utf-8"));
                if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                    this.data = {};
                    for (const [k, v] of Object.entries(raw)) {
                        if (typeof v === "string") this.data[k] = v;
                    }
                }
            }
        } catch { /* ignore read errors */ }
    }

    get(key: string): string | undefined {
        return this.data[key];
    }

    set(key: string, value: string): void {
        const candidate = { ...this.data, [key]: value };
        this.commit(candidate);
    }

    remove(key: string): void {
        const candidate = { ...this.data };
        delete candidate[key];
        this.commit(candidate);
    }

    getAll(): Record<string, string> {
        return { ...this.data };
    }

    /** Restore a previous complete value set as one durable publication. */
    restoreAll(snapshot: Record<string, string>): void {
        const candidate: Record<string, string> = {};
        for (const [key, value] of Object.entries(snapshot)) {
            // Empty strings are meaningful: they are exact prior persisted
            // state and must survive a cross-store rollback.
            if (typeof value === "string") candidate[key] = value;
        }
        this.commit(candidate);
    }

    /** Bulk update: set multiple keys at once, remove keys with empty values. */
    update(entries: Record<string, string>): void {
        const candidate = { ...this.data };
        for (const [k, v] of Object.entries(entries)) {
            if (v) candidate[k] = v;
            else delete candidate[k];
        }
        this.commit(candidate);
    }

    /** Persist first, then make the candidate observable in memory. */
    private commit(candidate: Record<string, string>): void {
        this.save(candidate);
        this.data = candidate;
    }

    private save(candidate: Record<string, string>): void {
        const dir = path.dirname(this.filePath);
        const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
            // Mode is applied when the temp inode is created, before secret bytes
            // are written. renameSync then publishes that owner-only inode atomically.
            this.fs.writeFileSync(temp, JSON.stringify(candidate, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
            this.fs.renameSync(temp, this.filePath);
        } catch {
            try { this.fs.unlinkSync(temp); } catch { /* only clean this invocation's temp file */ }
            // Never expose filesystem errors: their text can include a secret path or payload.
            throw new SecretsStorePersistenceError();
        }
    }
}

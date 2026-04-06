/**
 * SecretsStore — persists secret values in the state directory (gitignored).
 * Separate from project.yaml (config dir) so secrets never appear in git diffs.
 */
import fs from "node:fs";
import path from "node:path";

export class SecretsStore {
    private data: Record<string, string> = {};
    private readonly filePath: string;

    constructor(stateDir: string) {
        this.filePath = path.join(stateDir, "secrets.json");
        this.load();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
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
        this.data[key] = value;
        this.save();
    }

    remove(key: string): void {
        delete this.data[key];
        this.save();
    }

    getAll(): Record<string, string> {
        return { ...this.data };
    }

    /** Bulk update: set multiple keys at once, remove keys with empty values */
    update(entries: Record<string, string>): void {
        for (const [k, v] of Object.entries(entries)) {
            if (v) {
                this.data[k] = v;
            } else {
                delete this.data[k];
            }
        }
        this.save();
    }

    private save(): void {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
        } catch (err) {
            console.error("[secrets-store] Failed to save:", err);
        }
    }
}

import fs from "node:fs";
import path from "node:path";
import type { Decision } from "./decision-types.js";
import type { ToolApproveVerdict } from "./tool-approve-classifier.js";

export type ToolPermissionAuditDecision = "granted" | "denied";
export type ToolPermissionAuditSource = "user" | "auto" | "timeout";

export interface ToolPermissionAuditEntry {
	ts: number;
	sessionId: string;
	projectId?: string;
	toolName: string;
	toolGroup?: string;
	decision: ToolPermissionAuditDecision;
	source: ToolPermissionAuditSource;
	toolApproveDecision?: Decision<ToolApproveVerdict>;
}

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;

export class ToolPermissionAuditLog {
	private readonly auditDir: string;

	constructor(stateDir: string) {
		this.auditDir = path.join(stateDir, "tool-permission-audit");
	}

	append(sessionId: string, entry: ToolPermissionAuditEntry): void {
		fs.mkdirSync(this.auditDir, { recursive: true });
		const file = this.auditFile(sessionId);
		fs.appendFileSync(file, JSON.stringify(entry) + "\n");
		this.enforceCap(file);
	}

	read(sessionId: string): ToolPermissionAuditEntry[] {
		const file = this.auditFile(sessionId);
		if (!fs.existsSync(file)) return [];
		const entries: ToolPermissionAuditEntry[] = [];
		for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as ToolPermissionAuditEntry);
			} catch {
				// Skip corrupt partial lines rather than failing audit reads.
			}
		}
		return entries;
	}

	private auditFile(sessionId: string): string {
		return path.join(this.auditDir, safeBasename(sessionId) + ".jsonl");
	}

	private enforceCap(file: string): void {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			return;
		}
		if (stat.size <= MAX_AUDIT_BYTES) return;

		const lines = fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.length > 0);
		const kept: string[] = [];
		let bytes = 0;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i] + "\n";
			const lineBytes = Buffer.byteLength(line);
			if (bytes + lineBytes > MAX_AUDIT_BYTES) break;
			kept.push(line);
			bytes += lineBytes;
		}
		kept.reverse();

		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, kept.join(""));
		fs.renameSync(tmp, file);
	}
}

function safeBasename(sessionId: string): string {
	const stripped = sessionId.replace(/\.\./g, "_").replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
	return stripped || "session";
}

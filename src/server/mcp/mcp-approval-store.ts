import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandEnvRecord } from "./mcp-client.js";
import type { McpServerConfig } from "./mcp-types.js";

export type McpApprovalDecision = "approved" | "rejected";
export type McpApprovalState = "trusted" | "pending" | "approved" | "rejected" | "changed";

export interface McpApprovalIdentity {
  projectId: string;
  sourceId: string;
  serverName: string;
  fingerprint: string;
}

export interface McpApprovalDefinition {
  projectId?: string;
  sourceId: string;
  serverName: string;
  trust: "pretrusted" | "approval-required";
  config: McpServerConfig;
}

export interface McpApprovalClassification {
  required: boolean;
  state: McpApprovalState;
  fingerprint?: string;
  decidedAt?: string;
}

interface PersistedDecision extends McpApprovalIdentity {
  decision: McpApprovalDecision;
  decidedAt: string;
}

interface PersistedLedger {
  schema: 1;
  decisions: PersistedDecision[];
}

const LEDGER_FILE = "mcp-server-approvals.json";
const KEY_FILE = "mcp-server-approval.key";
const KEY_BYTES = 32;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = stableValue(child);
    }
    return out;
  }
  return value;
}

function validRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

/** Canonical behaviour-bearing MCP configuration. Unknown fields are retained. */
export function canonicalMcpServerConfig(config: McpServerConfig): unknown {
  const record = config as Record<string, unknown>;
  const known = new Set(["command", "args", "cwd", "env", "url", "headers", "transport"]);
  const unknownOwnFields: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (!known.has(key) && record[key] !== undefined) unknownOwnFields[key] = record[key];
  }
  const env = validRecord(config.env) ? expandEnvRecord(config.env) : config.env;
  return stableValue({
    schema: 1,
    transport: config.url ? "http" : "stdio",
    configuredTransport: record.transport ?? null,
    command: config.command ?? null,
    args: config.args ?? [],
    cwdSemantic: config.cwd ?? null,
    env: env ?? {},
    url: config.url ?? null,
    headers: config.headers ?? {},
    unknownOwnFields,
  });
}

export function validateMcpServerConfig(config: unknown): string | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "Server configuration must be an object.";
  const value = config as McpServerConfig;
  const commandPresent = typeof value.command === "string" && value.command.trim().length > 0;
  const urlPresent = typeof value.url === "string" && value.url.trim().length > 0;
  if (commandPresent === urlPresent) return "Configure exactly one non-empty command or HTTP(S) URL.";
  if (value.command !== undefined && !commandPresent) return "Command must be a non-empty string.";
  if (value.url !== undefined) {
    if (!urlPresent) return "URL must be a non-empty string.";
    try {
      const parsed = new URL(value.url!);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "URL must use HTTP or HTTPS.";
    } catch {
      return "URL must be a valid HTTP(S) URL.";
    }
  }
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string"))) {
    return "Arguments must be an array of strings.";
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") return "Working directory must be a string.";
  if (value.env !== undefined && !validRecord(value.env)) return "Environment must contain only string values.";
  if (value.headers !== undefined && !validRecord(value.headers)) return "Headers must contain only string values.";
  return undefined;
}

function isDecision(value: unknown): value is PersistedDecision {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (row.decision === "approved" || row.decision === "rejected")
    && [row.projectId, row.sourceId, row.serverName, row.fingerprint, row.decidedAt].every((entry) => typeof entry === "string" && entry.length > 0);
}

/** Headquarters-owned approval ledger and HMAC fingerprint key. */
export class McpApprovalStore {
  private key: Buffer | undefined;
  private decisions: PersistedDecision[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  readonly ledgerPath: string;
  readonly keyPath: string;

  constructor(private readonly stateDir: string) {
    this.ledgerPath = path.join(stateDir, LEDGER_FILE);
    this.keyPath = path.join(stateDir, KEY_FILE);
    this.load();
  }

  private load(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.decisions = this.readLedger();
    try {
      const key = fs.readFileSync(this.keyPath);
      if (key.length === KEY_BYTES) this.key = key;
    } catch {
      // A missing key is created below. Existing ledger rows remain harmless:
      // the new HMAC cannot reproduce their fingerprints, so they classify changed.
    }
    if (!this.key) this.key = this.createKey();
  }

  private readLedger(): PersistedDecision[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")) as Partial<PersistedLedger>;
      if (parsed.schema !== 1 || !Array.isArray(parsed.decisions)) return [];
      return parsed.decisions.filter(isDecision);
    } catch {
      return [];
    }
  }

  private createKey(): Buffer | undefined {
    const generated = crypto.randomBytes(KEY_BYTES);
    try {
      const fd = fs.openSync(this.keyPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, generated);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const existing = fs.readFileSync(this.keyPath);
          return existing.length === KEY_BYTES ? existing : undefined;
        } catch {
          return undefined;
        }
      }
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      console.error(`[mcp] MCP_APPROVAL_KEY_UNAVAILABLE (${code})`);
      return undefined;
    }
  }

  fingerprint(config: McpServerConfig): string | undefined {
    if (!this.key) return undefined;
    return crypto.createHmac("sha256", this.key)
      .update(JSON.stringify(canonicalMcpServerConfig(config)))
      .digest("hex");
  }

  classify(definition: McpApprovalDefinition): McpApprovalClassification {
    if (definition.trust === "pretrusted") return { required: false, state: "trusted" };
    const fingerprint = this.fingerprint(definition.config);
    if (!fingerprint || !definition.projectId) return { required: true, state: "pending", ...(fingerprint ? { fingerprint } : {}) };
    const tuple = this.decisions.filter((row) => row.projectId === definition.projectId
      && row.sourceId === definition.sourceId && row.serverName === definition.serverName);
    const exact = [...tuple].reverse().find((row) => row.fingerprint === fingerprint);
    if (exact) return { required: true, state: exact.decision, fingerprint, decidedAt: exact.decidedAt };
    return { required: true, state: tuple.length > 0 ? "changed" : "pending", fingerprint };
  }

  async decide(identity: McpApprovalIdentity, decision: McpApprovalDecision): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const decidedAt = new Date().toISOString();
      const next = this.decisions.filter((row) => !(row.projectId === identity.projectId
        && row.sourceId === identity.sourceId && row.serverName === identity.serverName
        && row.fingerprint === identity.fingerprint));
      next.push({ ...identity, decision, decidedAt });
      await this.persist(next);
      this.decisions = next;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persist(decisions: PersistedDecision[]): Promise<void> {
    const temporary = `${this.ledgerPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schema: 1, decisions } satisfies PersistedLedger, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporary, this.ledgerPath);
    } catch (error) {
      console.error("[mcp] MCP_APPROVAL_PERSIST_FAILED");
      throw Object.assign(new Error("Could not persist the MCP server approval decision."), { code: "MCP_APPROVAL_PERSIST_FAILED", cause: error });
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.unlink(temporary).catch(() => undefined);
    }
  }
}

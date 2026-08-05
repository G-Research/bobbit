import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BranchEntry = Record<string, any>;
type ParsedFrame =
  | { kind: "plain" }
  | { kind: "invalid"; promptId?: string }
  | { kind: "framed"; id: string; digest: string; body: string };

const FRAME_PREFIX = "\u001eBOBBIT_PROMPT_V1:";
const FRAME_SUFFIX = "\u001f";
const ENTRY_TYPE = "bobbit:prompt-delivery-v1";
const ACK_TYPE = "bobbit:prompt-delivery-ack-v1";
const CAPABILITY_EVENT = "bobbit_prompt_delivery_capability";
const FAILURE_EVENT = "bobbit_prompt_delivery_failure";
const PROTOCOL_VERSION = 1;
const EXTENSION_VERSION = "1.0.0";

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writeControlEvent(event: Record<string, unknown>): void {
  try {
    // Pi redirects process.stdout.write/console to stderr so extensions cannot
    // corrupt RPC JSONL. This extension *is* an RPC transport component: use one
    // small synchronous fd write so the bridge receives an atomic control frame.
    fs.writeSync(1, `${JSON.stringify(event)}\n`);
  } catch {
    // If the control channel itself is unavailable, returning `handled` below
    // still prevents a private envelope from reaching Pi's transcript/model.
  }
}

function parseFrame(text: unknown): ParsedFrame {
  if (typeof text !== "string" || !text.startsWith(FRAME_PREFIX)) return { kind: "plain" };
  const end = text.indexOf(FRAME_SUFFIX, FRAME_PREFIX.length);
  if (end < 0) return { kind: "invalid" };
  try {
    const encoded = text.slice(FRAME_PREFIX.length, end);
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const body = text.slice(end + FRAME_SUFFIX.length);
    if (!envelope || envelope.v !== PROTOCOL_VERSION || typeof envelope.id !== "string" || envelope.id.length < 1 || envelope.id.length > 256) {
      return { kind: "invalid", promptId: typeof envelope?.id === "string" ? envelope.id : undefined };
    }
    if (typeof envelope.digest !== "string" || envelope.digest !== digest(body)) {
      return { kind: "invalid", promptId: envelope.id };
    }
    return { kind: "framed", id: envelope.id, digest: envelope.digest, body };
  } catch {
    return { kind: "invalid" };
  }
}

function messageText(message: any): string | undefined {
  if (!message || (message.role !== "user" && message.role !== "user-with-attachments")) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content.filter((part: any) => part && part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
}

function matchingMarkers(branch: BranchEntry[], promptId: string): BranchEntry[] {
  return branch.filter((entry) => entry && entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data && entry.data.promptId === promptId);
}

function hasCommittedUser(branch: BranchEntry[], promptId: string, expectedDigest: string): boolean {
  for (const marker of matchingMarkers(branch, promptId)) {
    const markerIndex = branch.indexOf(marker);
    const committed = branch.slice(markerIndex + 1).some((entry) => {
      if (!entry || entry.type !== "message") return false;
      const text = messageText(entry.message);
      return text !== undefined && digest(text) === expectedDigest;
    });
    if (committed) return true;
  }
  return false;
}

function appendAck(pi: ExtensionAPI, promptId: string, expectedDigest: string): void {
  pi.appendEntry(ACK_TYPE, {
    protocolVersion: PROTOCOL_VERSION,
    promptId,
    digest: expectedDigest,
  });
}

export default function promptDeliveryExtension(pi: ExtensionAPI) {
  // This structured stdout event is consumed by RpcBridge and never forwarded
  // to clients. Its exact version proves this extension executed before Bobbit
  // enables framed stable-id delivery.
  writeControlEvent({
    type: CAPABILITY_EVENT,
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: EXTENSION_VERSION,
  });

  // Multiple prompt/steer inputs can be accepted during one agent run. Keep all
  // reservations until agent_end proves Pi has committed each following user
  // entry, then append ACKs to Pi's durable transcript.
  const pending = new Map<string, string>();

  pi.on("input", (event, ctx) => {
    const parsed = parseFrame(event.text);
    if (parsed.kind === "plain") return undefined;
    if (parsed.kind !== "framed") {
      writeControlEvent({
        type: FAILURE_EVENT,
        protocolVersion: PROTOCOL_VERSION,
        promptId: parsed.promptId,
        code: "invalid-envelope",
      });
      return { action: "handled" };
    }

    try {
      const branch = ctx.sessionManager.getBranch();
      const markers = matchingMarkers(branch, parsed.id);
      if (markers.some((entry) => entry.data.digest !== parsed.digest)) {
        writeControlEvent({
          type: FAILURE_EVENT,
          protocolVersion: PROTOCOL_VERSION,
          promptId: parsed.id,
          code: "identity-collision",
        });
        return { action: "handled" };
      }

      if (hasCommittedUser(branch, parsed.id, parsed.digest)) {
        // A resend after append-before-ACK is a no-op turn. The durable ACK lets
        // the restarted gateway remove its crash-left FIFO row.
        appendAck(pi, parsed.id, parsed.digest);
        return { action: "handled" };
      }

      if (markers.length === 0) {
        // Reservation must succeed before the transport envelope is stripped.
        // Any failure is caught below and fails closed as a handled input.
        pi.appendEntry(ENTRY_TYPE, {
          protocolVersion: PROTOCOL_VERSION,
          promptId: parsed.id,
          digest: parsed.digest,
        });
      }
      pending.set(parsed.id, parsed.digest);
      return { action: "transform", text: parsed.body, images: event.images };
    } catch {
      pending.delete(parsed.id);
      writeControlEvent({
        type: FAILURE_EVENT,
        protocolVersion: PROTOCOL_VERSION,
        promptId: parsed.id,
        code: "reservation-failed",
      });
      return { action: "handled" };
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (pending.size === 0) return;
    let branch;
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      return;
    }
    for (const [promptId, expectedDigest] of [...pending]) {
      if (!hasCommittedUser(branch, promptId, expectedDigest)) continue;
      try {
        appendAck(pi, promptId, expectedDigest);
        pending.delete(promptId);
      } catch {
        // Keep the reservation pending. A resend with the same id will inspect
        // the committed marker+user pair and append the ACK without another turn.
      }
    }
  });
}

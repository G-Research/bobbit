import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const FRAME_PREFIX = "\u001eBOBBIT_PROMPT_V1:";
const FRAME_SUFFIX = "\u001f";
const ENTRY_TYPE = "bobbit:prompt-delivery-v1";
const ACK_TYPE = "bobbit:prompt-delivery-ack-v1";

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseFrame(text) {
  if (typeof text !== "string" || !text.startsWith(FRAME_PREFIX)) return undefined;
  const end = text.indexOf(FRAME_SUFFIX, FRAME_PREFIX.length);
  if (end < 0) return undefined;
  try {
    const encoded = text.slice(FRAME_PREFIX.length, end);
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const body = text.slice(end + FRAME_SUFFIX.length);
    if (!envelope || envelope.v !== 1 || typeof envelope.id !== "string" || envelope.id.length < 1 || envelope.id.length > 256) return undefined;
    if (typeof envelope.digest !== "string" || envelope.digest !== digest(body)) return undefined;
    return { id: envelope.id, digest: envelope.digest, body };
  } catch {
    return undefined;
  }
}

function messageText(message) {
  if (!message || (message.role !== "user" && message.role !== "user-with-attachments")) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

function appendLedger(record) {
  const file = process.env.BOBBIT_PROMPT_LEDGER_PATH;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, JSON.stringify({ ...record, at: Date.now() }) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // The Pi transcript entry below remains authoritative. Ledger I/O must not
    // expose the private transport envelope or block legacy agent operation.
  }
}

export default function promptDeliveryExtension(pi) {
  let active;

  pi.on("input", (event, ctx) => {
    const framed = parseFrame(event.text);
    if (!framed) return undefined;

    const branch = ctx.sessionManager.getBranch();
    const markers = branch.filter((entry) => entry && entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data && entry.data.promptId === framed.id);
    if (markers.some((entry) => entry.data.digest !== framed.digest)) {
      appendLedger({ promptId: framed.id, digest: framed.digest, state: "collision" });
      return { action: "handled" };
    }

    for (const marker of markers) {
      const markerIndex = branch.indexOf(marker);
      const committed = branch.slice(markerIndex + 1).some((entry) => {
        if (!entry || entry.type !== "message") return false;
        const text = messageText(entry.message);
        return text !== undefined && digest(text) === framed.digest;
      });
      if (committed) {
        appendLedger({ promptId: framed.id, digest: framed.digest, state: "duplicate" });
        // This durable Pi entry is also emitted as `entry_appended`, allowing a
        // restarted gateway to settle its crash-left row without a second turn.
        pi.appendEntry(ACK_TYPE, { promptId: framed.id, digest: framed.digest });
        return { action: "handled" };
      }
    }

    appendLedger({ promptId: framed.id, digest: framed.digest, state: "reserved" });
    if (markers.length === 0) {
      pi.appendEntry(ENTRY_TYPE, { promptId: framed.id, digest: framed.digest });
    }
    appendLedger({ promptId: framed.id, digest: framed.digest, state: "accepted" });
    active = { promptId: framed.id, digest: framed.digest };
    return { action: "transform", text: framed.body, images: event.images };
  });

  pi.on("before_agent_start", () => {
    if (active) appendLedger({ ...active, state: "executing" });
  });

  pi.on("agent_end", () => {
    if (!active) return;
    appendLedger({ ...active, state: "settled" });
    active = undefined;
  });
}

/**
 * Canonical stable-prompt transport used by generated standalone Pi RPC
 * fixtures. Explicit `--agent-cli` programs do not load Pi extensions, so they
 * must implement the exact v1 boundary themselves rather than bypassing the
 * production handshake.
 *
 * The generated program must define `send`, `runPrompt`,
 * `persistPromptReservation`, `persistPromptAck`, and `handleAgentRpc` before
 * this source is inserted.
 */
export function stablePromptDeliveryRpcTransportSource(): string {
	return `
const PROMPT_FRAME_PREFIX = "\\u001eBOBBIT_PROMPT_V1:";
const PROMPT_FRAME_SUFFIX = "\\u001f";
const PROMPT_PROTOCOL_VERSION = 1;
const promptReservations = new Map();
const committedPrompts = new Map();

function promptDigest(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseStablePrompt(text) {
	if (typeof text !== "string" || !text.startsWith(PROMPT_FRAME_PREFIX)) return { kind: "plain", body: text || "" };
	const end = text.indexOf(PROMPT_FRAME_SUFFIX, PROMPT_FRAME_PREFIX.length);
	if (end < 0) return { kind: "invalid" };
	let envelope;
	try {
		envelope = JSON.parse(Buffer.from(text.slice(PROMPT_FRAME_PREFIX.length, end), "base64url").toString("utf8"));
	} catch {
		return { kind: "invalid" };
	}
	const body = text.slice(end + PROMPT_FRAME_SUFFIX.length);
	const promptId = typeof envelope?.id === "string" ? envelope.id : undefined;
	if (envelope?.v !== PROMPT_PROTOCOL_VERSION || !promptId || promptId.length > 256
		|| typeof envelope.digest !== "string" || !/^[a-f0-9]{64}$/.test(envelope.digest)
		|| envelope.digest !== promptDigest(body)) {
		return { kind: "invalid", promptId };
	}
	return { kind: "framed", promptId, digest: envelope.digest, body };
}

function deliveryFailure(promptId, code) {
	send({
		type: "bobbit_prompt_delivery_failure",
		protocolVersion: PROMPT_PROTOCOL_VERSION,
		...(promptId ? { promptId } : {}),
		code,
	});
}

function deliveryEntry(customType, promptId, digest) {
	return {
		type: "custom",
		customType,
		data: { protocolVersion: PROMPT_PROTOCOL_VERSION, promptId, digest },
	};
}

function acknowledgeCommittedPrompt(promptId, digest) {
	const entry = deliveryEntry("bobbit:prompt-delivery-ack-v1", promptId, digest);
	// Persist the ACK before publishing entry_appended, matching Pi appendEntry.
	persistPromptAck(entry);
	send({ type: "entry_appended", entry });
}

function acceptPrompt(message) {
	const parsed = parseStablePrompt(message.message);
	if (parsed.kind === "invalid") {
		deliveryFailure(parsed.promptId, "invalid-envelope");
		return;
	}
	if (parsed.kind === "plain") {
		send({ type: "response", id: message.id, success: true });
		void Promise.resolve(runPrompt(parsed.body));
		return;
	}

	const reservedDigest = promptReservations.get(parsed.promptId);
	if (reservedDigest !== undefined) {
		if (reservedDigest !== parsed.digest) {
			deliveryFailure(parsed.promptId, "identity-collision");
			return;
		}
		send({ type: "response", id: message.id, success: true });
		if (committedPrompts.get(parsed.promptId) === parsed.digest) {
			acknowledgeCommittedPrompt(parsed.promptId, parsed.digest);
		}
		return;
	}

	try {
		const reservation = deliveryEntry("bobbit:prompt-delivery-v1", parsed.promptId, parsed.digest);
		// Reserve and persist identity before acknowledging RPC acceptance or
		// exposing the unframed body to the generated model fixture.
		persistPromptReservation(reservation);
		promptReservations.set(parsed.promptId, parsed.digest);
	} catch {
		deliveryFailure(parsed.promptId, "reservation-failed");
		return;
	}

	send({ type: "response", id: message.id, success: true });
	void Promise.resolve(runPrompt(parsed.body)).then(() => {
		committedPrompts.set(parsed.promptId, parsed.digest);
		acknowledgeCommittedPrompt(parsed.promptId, parsed.digest);
	}, () => deliveryFailure(parsed.promptId, "prompt-run-failed"));
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let message;
	try { message = JSON.parse(line); } catch { return; }
	if (message.type === "prompt" || message.type === "follow_up") {
		acceptPrompt(message);
		return;
	}
	handleAgentRpc(message);
});

// Install stdin handling first. The exact capability then proves this
// standalone generation is ready for framed delivery before it reports idle.
send({ type: "bobbit_prompt_delivery_capability", protocolVersion: 1, extensionVersion: "1.0.0" });
send({ type: "session_status", status: "idle" });
`;
}

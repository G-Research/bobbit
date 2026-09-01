import type { WsMsg } from "../../../harnesses/integration/gateway/e2e-setup.js";

export interface ReliableMockCore {
	readonly env: Record<string, string | undefined>;
	armBarrier(name: string): string;
	waitForBarrier(name: string): Promise<Record<string, unknown>>;
	releaseBarrier(name: string): boolean;
	releaseAllBarriers(): void;
	configureReliableScenario(patch: Record<string, unknown>): void;
	readonly barrierJournal: Array<Record<string, unknown>>;
	readonly commandJournal: Array<Record<string, unknown>>;
}

export function reliableMockCore(gateway: any, sessionId: string): ReliableMockCore {
	const core = gateway.sessionManager.getSession(sessionId)?.rpcClient?._agent;
	if (!core || typeof core.armBarrier !== "function") {
		throw new Error(`session ${sessionId} does not expose reliable-turn mock barriers`);
	}
	return core as ReliableMockCore;
}

export function intentRows(frame: WsMsg | undefined): any[] {
	if (!frame) return [];
	const candidates = [
		frame.queue,
		frame.outbox,
		frame.intents,
		frame.intent ? [frame.intent] : undefined,
		frame.data?.deliveryOutbox,
		frame.data?.outbox,
		frame.data?.pendingIntents,
	];
	return candidates.find(Array.isArray) ?? [];
}

export function intentId(row: any): string | undefined {
	return row?.intentId ?? row?.id ?? row?.deliveryIntentId;
}

export function frameHasIntentIds(frame: WsMsg, ids: readonly string[]): boolean {
	const found = new Set(intentRows(frame).map(intentId).filter(Boolean));
	return ids.every((id) => found.has(id));
}

export function latestIntentProjection(messages: readonly WsMsg[]): WsMsg | undefined {
	return [...messages].reverse().find((frame) =>
		frame.type === "queue_update" || frame.type === "intent_update" || frame.type === "delivery_outbox",
	);
}

export function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

export function userDeliveryFrames(messages: readonly WsMsg[], text: string): WsMsg[] {
	return messages.filter((frame) =>
		frame.type === "event"
		&& (frame.data?.type === "message_start" || frame.data?.type === "message_end")
		&& (frame.data?.message?.role === "user" || frame.data?.message?.role === "user-with-attachments")
		&& messageText(frame.data.message) === text,
	);
}

export function userMessageEnds(messages: readonly WsMsg[], text: string): WsMsg[] {
	return userDeliveryFrames(messages, text).filter((frame) => frame.data?.type === "message_end");
}

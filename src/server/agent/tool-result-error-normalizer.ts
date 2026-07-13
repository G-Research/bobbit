function hasExplicitErrorFlag(value: unknown): boolean {
	return !!value && typeof value === "object" && ((value as any).isError === true || (value as any).is_error === true);
}

function parseJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
	try { return JSON.parse(trimmed); } catch { return undefined; }
}

function textFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
			return "";
		})
		.join("\n")
		.trim();
	return text || undefined;
}

function messageCarriesReturnedErrorFlag(message: any): boolean {
	if (!message || typeof message !== "object") return false;
	if (hasExplicitErrorFlag(message)) return true;
	const directText = textFromContent(message.content);
	if (directText && hasExplicitErrorFlag(parseJsonObject(directText))) return true;
	return false;
}

function contentCarriesReturnedErrorFlag(value: unknown): boolean {
	const text = textFromContent(value);
	return !!text && hasExplicitErrorFlag(parseJsonObject(text));
}

function eventCarriesReturnedErrorFlag(event: any): boolean {
	if (!event || typeof event !== "object") return false;
	if (hasExplicitErrorFlag(event)) return true;
	if (hasExplicitErrorFlag(event.result) || hasExplicitErrorFlag(event.output)) return true;
	if (typeof event.output === "string" && hasExplicitErrorFlag(parseJsonObject(event.output))) return true;
	if (contentCarriesReturnedErrorFlag(event.result?.content) || contentCarriesReturnedErrorFlag(event.output?.content)) return true;
	return false;
}

function isToolResultMessage(message: any): boolean {
	return message?.role === "toolResult" || message?.role === "tool_result" || message?.role === "tool";
}

export function normalizeToolResultErrorMessage<T>(message: T): T {
	const msg: any = message;
	if (!isToolResultMessage(msg)) return message;
	if (msg.isError === true) return message;
	if (!messageCarriesReturnedErrorFlag(msg)) return message;
	return { ...msg, isError: true };
}

export function normalizeToolResultErrorEvent<T>(event: T): T {
	const ev: any = event;
	if (!ev || typeof ev !== "object") return event;
	if ((ev.type === "message_end" || ev.type === "message_update") && ev.message) {
		const message = normalizeToolResultErrorMessage(ev.message);
		return message === ev.message ? event : { ...ev, message };
	}
	if (ev.type === "tool_execution_end" && ev.isError !== true && eventCarriesReturnedErrorFlag(ev)) {
		return { ...ev, isError: true };
	}
	return event;
}

export function normalizeToolResultErrorMessages<T>(messages: T): T {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const out = messages.map((message) => {
		const normalized = normalizeToolResultErrorMessage(message);
		if (normalized !== message) changed = true;
		return normalized;
	});
	return (changed ? out : messages) as T;
}

export function normalizeToolResultErrorSnapshot<T>(snapshot: T): T {
	const raw: any = snapshot;
	if (Array.isArray(raw)) return normalizeToolResultErrorMessages(raw) as T;
	if (raw && typeof raw === "object" && Array.isArray(raw.messages)) {
		const messages = normalizeToolResultErrorMessages(raw.messages);
		return messages === raw.messages ? snapshot : { ...raw, messages };
	}
	return snapshot;
}

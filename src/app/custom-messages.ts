import type { Message } from "@mariozechner/pi-ai";
import type { AgentMessage, MessageRenderer } from "../ui/index.js";
import { defaultConvertToLlm, registerMessageRenderer } from "../ui/index.js";
import { html } from "lit";

// ============================================================================
// 1. EXTEND AppMessage TYPE VIA DECLARATION MERGING
// ============================================================================

export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	category?: "system" | "task" | "team" | "error";
	timestamp: string;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
	}
}

// ============================================================================
// 2. CATEGORY ICONS
// ============================================================================

const CATEGORY_ICONS: Record<string, string> = {
	system: "\u27F3",  // ⟳
	task: "\u2713",    // ✓
	team: "\u25CF",    // ●
	error: "\u2715",   // ✕
};

// ============================================================================
// 3. COMPACT INLINE NOTIFICATION RENDERER
// ============================================================================

const systemNotificationRenderer: MessageRenderer<SystemNotificationMessage> = {
	render: (notification) => {
		const category = notification.category || "system";
		const icon = CATEGORY_ICONS[category] || CATEGORY_ICONS.system;
		const time = new Date(notification.timestamp).toLocaleTimeString();

		return html`
			<div class="notification-inline notification-${category}">
				<span class="notification-icon">${icon}</span>
				<span class="notification-text">${notification.message}</span>
				<span class="notification-time">${time}</span>
			</div>
		`;
	},
};

// ============================================================================
// 4. REGISTER RENDERER
// ============================================================================

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
}

// ============================================================================
// 5. HELPER TO CREATE CUSTOM MESSAGES
// ============================================================================

export function createSystemNotification(
	message: string,
	category: "system" | "task" | "team" | "error" = "system",
	variant: "default" | "destructive" = "default",
): SystemNotificationMessage {
	return {
		role: "system-notification",
		message,
		variant,
		category,
		timestamp: new Date().toISOString(),
	};
}

// ============================================================================
// 6. CUSTOM MESSAGE TRANSFORMER
// ============================================================================

export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	const processed = messages.map((m): AgentMessage => {
		if (m.role === "system-notification") {
			const notification = m as SystemNotificationMessage;
			return {
				role: "user",
				content: `<system>${notification.message}</system>`,
				timestamp: Date.now(),
			};
		}
		return m;
	});

	return defaultConvertToLlm(processed);
}

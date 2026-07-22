import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaultConvertToLlm } from "../ui/components/Messages.js";
import { registerMessageRenderer, type MessageRenderer } from "../ui/components/message-renderer-registry.js";
import { html } from "lit";
import { gatewayFetch } from "./api.js";
import { isSubgoalsEnabled } from "./subgoals-flag.js";
import type { BobbitMessage, MessageAuthor } from "../shared/message-author.js";

const CLIENT_SYSTEM_AUTHOR: MessageAuthor = {
	kind: "system",
	id: "system:bobbit",
	label: "Bobbit",
};

// ============================================================================
// 1. EXTEND AppMessage TYPE VIA DECLARATION MERGING
// ============================================================================

export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	category?: "system" | "task" | "team" | "error";
	timestamp: string;
	author?: MessageAuthor;
}

/**
 * Pending plan-mutation card (Phase 5b, fix-up classifier path).
 * Emitted on a `mutation_pending` WS event for goals whose `goal-plan` has
 * been frozen and a re-plan went into the approval queue.
 */
export interface MutationPendingMessage {
	role: "mutation-pending";
	goalId: string;
	requestId: string;
	kind: "fix-up" | "expansion" | "restructure" | "criteria-drop";
	summary: string;
	timestamp: string;
	author?: MessageAuthor;
	/** Set to "approved" / "rejected" once the user clicks; disables buttons. */
	decided?: "approved" | "rejected";
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
		"mutation-pending": MutationPendingMessage;
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

async function _decideMutation(goalId: string, requestId: string, decision: "approve" | "reject"): Promise<void> {
	try {
		await gatewayFetch(`/api/goals/${goalId}/mutation/${requestId}/decision`, {
			method: "POST",
			body: JSON.stringify({ decision }),
		});
	} catch (err) {
		// Best-effort — the WS `mutation_decided` event is the source of truth
		// for clearing this card. If we lose the race, the card stays visible
		// and the user can retry.
		console.error("[mutation-pending] decision failed:", err);
	}
}

const mutationPendingRenderer: MessageRenderer<MutationPendingMessage> = {
	render: (msg) => {
		// Belt-and-braces: with the Subgoals (Experimental) flag off the
		// `mutation_pending` event can't fire (server gate), but if a stale
		// in-memory transcript carries one, suppress its UI here too.
		if (!isSubgoalsEnabled()) return html``;
		const decided = msg.decided;
		const time = new Date(msg.timestamp).toLocaleTimeString();
		const kindBadge: Record<string, string> = {
			"fix-up": "Fix-up",
			"expansion": "Expansion",
			"restructure": "Restructure",
			"criteria-drop": "Criteria-drop",
		};
		const badge = kindBadge[msg.kind] ?? msg.kind;
		return html`
			<div data-testid="mutation-pending-card"
				class="notification-inline"
				style="display:block;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card);">
				<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
					<span class="notification-icon">⟳</span>
					<span style="font-weight:600;font-size:13px;">Plan mutation pending — ${badge}</span>
					<span class="notification-time" style="margin-left:auto;font-size:11px;color:var(--muted-foreground);">${time}</span>
				</div>
				<div style="font-size:12px;color:var(--muted-foreground);margin-bottom:8px;" data-testid="mutation-pending-summary">${msg.summary}</div>
				<div style="display:flex;gap:8px;">
					<button data-testid="mutation-pending-approve"
						?disabled=${!!decided}
						style="padding:4px 10px;border-radius:6px;border:1px solid var(--primary);background:var(--primary);color:var(--primary-foreground);cursor:pointer;font-size:12px;${decided ? "opacity:0.6;cursor:default;" : ""}"
						@click=${() => { if (!decided) { msg.decided = "approved"; _decideMutation(msg.goalId, msg.requestId, "approve"); } }}>
						${decided === "approved" ? "Approved ✓" : "Approve"}
					</button>
					<button data-testid="mutation-pending-reject"
						?disabled=${!!decided}
						style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--foreground);cursor:pointer;font-size:12px;${decided ? "opacity:0.6;cursor:default;" : ""}"
						@click=${() => { if (!decided) { msg.decided = "rejected"; _decideMutation(msg.goalId, msg.requestId, "reject"); } }}>
						${decided === "rejected" ? "Rejected ✗" : "Reject"}
					</button>
				</div>
			</div>
		`;
	},
};

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
	registerMessageRenderer("mutation-pending", mutationPendingRenderer);
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
		author: CLIENT_SYSTEM_AUTHOR,
	};
}

export function createMutationPending(
	goalId: string,
	requestId: string,
	kind: MutationPendingMessage["kind"],
	summary: string,
): MutationPendingMessage {
	return {
		role: "mutation-pending",
		goalId,
		requestId,
		kind,
		summary,
		timestamp: new Date().toISOString(),
		author: CLIENT_SYSTEM_AUTHOR,
	};
}

// ============================================================================
// 6. CUSTOM MESSAGE TRANSFORMER
// ============================================================================

export function customConvertToLlm(messages: BobbitMessage<AgentMessage>[]): Message[] {
	const processed = messages.map((m): BobbitMessage<AgentMessage> => {
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

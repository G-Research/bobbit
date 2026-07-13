/** Internal provenance for prompts delivered to an agent session. */
export type PromptSource =
	| "user"
	| "auto-nudge"
	| "task-notification"
	| "verification"
	| "system"
	| "agent"
	| "child-complete"
	| "extension";

export const PROMPT_SOURCES: readonly PromptSource[] = Object.freeze([
	"user",
	"auto-nudge",
	"task-notification",
	"verification",
	"system",
	"agent",
	"child-complete",
	"extension",
]);

export function isPromptSource(value: unknown): value is PromptSource {
	return typeof value === "string" && (PROMPT_SOURCES as readonly string[]).includes(value);
}

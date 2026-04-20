/**
 * Ask tool extension for Bobbit.
 *
 * Registers `ask_user_choices` — posts 1–5 multiple-choice questions to the
 * user as an inline widget. This tool is **non-blocking**: the tool call
 * returns immediately with a stub result and the current assistant turn ends.
 *
 * The user's answers arrive later as a separate user message whose text is the
 * envelope:
 *
 *     [ask_user_choices_response tool_use_id=<id>]
 *     {"answers":[{"question":"...","selected":"...","other_text":null}, ...]}
 *
 * See src/shared/ask-envelope.ts for the canonical format. The envelope is
 * appended to the transcript by `POST /api/internal/user-question/submit`
 * (called by the UI widget).
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const sessionId = process.env.BOBBIT_SESSION_ID;
	if (!sessionId) return;

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined };
	}

	pi.registerTool({
		name: "ask_user_choices",
		label: "Ask User Choices",
		description: [
			"Post 1–5 multiple-choice questions to the user as an inline widget.",
			"Non-blocking: the tool returns immediately; the user's answers arrive later as a separate user message.",
			"Calling this tool ends your current turn.",
		].join(" "),
		promptSnippet: [
			"Post multiple-choice questions to the user. The tool returns immediately and ends your turn.",
			"Answers arrive later as a user message prefixed with `[ask_user_choices_response tool_use_id=<id>]`",
			"followed by a JSON body `{\"answers\":[...]}`. Match tool_use_id to your tool call.",
		].join(" "),
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ minLength: 1, description: "The question prompt" }),
					options: Type.Array(Type.String({ minLength: 1 }), {
						minItems: 2,
						maxItems: 8,
						description: "2–8 answer options",
					}),
					allow_other: Type.Optional(Type.Boolean({
						description: "If true, render an 'Other' option with a free-text input",
					})),
					multi: Type.Optional(Type.Boolean({
						description: "If true, user may select multiple options; selected is returned as a string[].",
					})),
					min: Type.Optional(Type.Integer({
						minimum: 1,
						description: "Minimum selections when multi:true (default 1).",
					})),
					max: Type.Optional(Type.Integer({
						minimum: 1,
						description: "Maximum selections when multi:true (default = options.length).",
					})),
				}),
				{ minItems: 1, maxItems: 5, description: "1–5 multiple-choice questions" },
			),
		}),
		async execute(toolUseId, _params) {
			// Non-blocking: return the stub immediately. The tool_use event flowing
			// through the agent's stdout → pi-coding-agent → our WS broadcast is
			// what tells the UI to render the widget. When the user submits, the
			// server appends a `[ask_user_choices_response ...]` envelope to the
			// transcript as a normal user message, which wakes the agent.
			return ok({ status: "posted", tool_use_id: toolUseId });
		},
	});

	console.log(`[ask-tools] Registered ask_user_choices for session ${sessionId}`);
}

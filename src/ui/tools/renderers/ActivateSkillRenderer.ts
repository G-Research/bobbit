/**
 * Renderer for the built-in `activate_skill` tool.
 *
 * The agent calls this tool to autonomously activate a discovered skill
 * (the level-1 progressive-disclosure activation path from the Agent
 * Skills spec). The server resolves the skill via `getSlashSkill` +
 * `buildSlashSkillPrompt` and returns the expanded body as the tool
 * result. We render it as the same `<skill-chip>` element used inside
 * user message bubbles so autonomous activation is visually
 * indistinguishable from a user-typed `/skill` invocation.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Sparkles } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import "../../components/SkillChip.js";
import type { SkillChipData } from "../../components/SkillChip.js";

interface ActivateSkillParams {
	name?: string;
	args?: string;
}

interface ActivateSkillDetails {
	skillExpansion?: {
		name: string;
		args?: string;
		source?: string;
		filePath?: string;
		expanded: string;
	};
}

export class ActivateSkillRenderer
	implements ToolRenderer<ActivateSkillParams, ActivateSkillDetails>
{
	render(
		params: ActivateSkillParams | undefined,
		result: ToolResultMessage<ActivateSkillDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const name = params?.name?.trim();
		const args = params?.args?.trim();

		// While streaming or before the result arrives, fall back to a
		// regular header. The chip needs the snapshotted expansion body
		// from the tool result.
		const exp = result?.details?.skillExpansion;
		if (!exp) {
			const label = name ? `Activating /${name}${args ? ` ${args}` : ""}\u2026` : "Activating skill\u2026";
			if (result?.isError) {
				const errText =
					result.content
						?.filter((c) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n") || "Failed to activate skill";
				return {
					content: html`
						<div class="space-y-2">
							${renderHeader(state, Sparkles, name ? `/${name}` : "activate_skill")}
							<div class="text-sm text-destructive">${errText}</div>
						</div>
					`,
					isCustom: false,
				};
			}
			return { content: renderHeader(state, Sparkles, label), isCustom: false };
		}

		const data: SkillChipData = {
			name: exp.name,
			args: exp.args,
			source: exp.source,
			filePath: exp.filePath,
			expanded: exp.expanded,
		};
		return {
			content: html`<skill-chip .data=${data} .block=${true}></skill-chip>`,
			isCustom: false,
		};
	}
}

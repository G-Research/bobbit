/**
 * Conditional-block processor for prompt templates.
 *
 * Syntax: `{if:NAME} … {endif:NAME}` — the open and close tags BOTH carry the
 * flag name so mismatches/nesting are validatable. A block's body is kept iff
 * `flags[NAME]` is truthy AND every enclosing block is also kept. Blocks may
 * nest. An unknown flag is treated as false (body removed) — gating fails
 * closed, never leaking content that was meant to be conditional.
 *
 * Tag names match `[A-Za-z0-9_]+`. Surrounding whitespace/newlines are left
 * as-authored; templates should put tags on their own lines so removal leaves
 * clean spacing.
 *
 * Throws on a malformed template (an `{endif:X}` with no open, a close whose
 * name doesn't match the innermost open, or an unclosed `{if:X}`). These are
 * authoring bugs — pinned by tests/prompt-conditionals.test.ts and the
 * template-validity scan — so failing loud at assembly time is correct.
 *
 * Lives in its own module (no imports) so both role-prompt.ts and
 * team-manager.ts can use it without a circular dependency.
 */
export function applyPromptConditionals(text: string, flags: Record<string, boolean>): string {
	if (!text.includes("{if:") && !text.includes("{endif:")) return text;
	const re = /\{if:([A-Za-z0-9_]+)\}|\{endif:([A-Za-z0-9_]+)\}/g;
	let out = "";
	let lastIndex = 0;
	let emitting = true;
	const stack: Array<{ name: string; parentEmitting: boolean }> = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (emitting) out += text.slice(lastIndex, m.index);
		lastIndex = re.lastIndex;
		if (m[1] !== undefined) {
			// {if:NAME}
			const name = m[1];
			stack.push({ name, parentEmitting: emitting });
			emitting = emitting && !!flags[name];
		} else {
			// {endif:NAME}
			const name = m[2]!;
			const top = stack.pop();
			if (!top) throw new Error(`applyPromptConditionals: unmatched {endif:${name}}`);
			if (top.name !== name) {
				throw new Error(`applyPromptConditionals: {if:${top.name}} closed by {endif:${name}}`);
			}
			emitting = top.parentEmitting;
		}
	}
	if (stack.length > 0) {
		throw new Error(`applyPromptConditionals: unclosed {if:${stack[stack.length - 1].name}}`);
	}
	out += text.slice(lastIndex);
	return out;
}

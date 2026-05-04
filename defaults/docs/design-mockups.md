# Design Mockups

When mocking up UI changes, animations, or visual design options, build a
**high-fidelity interactive preview** in the side panel — not a rough sketch.
The user should be able to look at the mockup and know exactly how the final
product will look and feel.

## Surface — always the live preview panel

For mockups, always use `preview_open(html=...)`. **Never** also write a
`.html` file for the same artefact.

```
preview_open(html="<link rel='stylesheet' href='/src/ui/app.css'><!-- ... -->")
```

The panel auto-updates on each call, giving the user real-time visual
feedback. The `<link>` to the app stylesheet gives you Tailwind 4 plus every
theme variable for pixel-accurate fidelity with the real app.

For the full surface-selection rule (when to write a file vs. when to use the
panel) and complete theme-token reference, see
[`defaults/docs/html-rendering.md`](html-rendering.md).

## Process — do the homework first

Before writing any mockup HTML, **read the actual source code** to understand:

- The exact rendering technique (e.g. pixel-art via CSS box-shadow, SVG, canvas).
- Real values: colours, sizes, scales, spacing, font stacks, border-radius.
- The animation system: what keyframes exist, what properties they animate,
  timing functions and durations.
- The design system's semantic conventions: which visual properties carry
  meaning (e.g. colour = identity vs. colour = state).
- How variants are produced (e.g. hue-rotate filters vs. distinct palettes).

This research is what separates a useful mockup from a misleading one. If you
skip it and approximate, the user will make decisions based on something that
doesn't represent reality.

## Principles for the mockup itself

1. **Match the real product exactly.** Use the same rendering technique at
   the same scale. If the product uses pixel-art box-shadows at 1.6x scale
   with specific hex colours, the mockup uses identical box-shadows at 1.6x
   scale with those hex colours. Never approximate with a different technique
   (e.g. don't use a PNG or SVG to represent something built with CSS
   box-shadows). **Better: reference the real CSS directly** via `<link>`.

2. **Show real context.** Render proposals inside a facsimile of the
   surrounding UI — a sidebar mock, a toolbar, a message list. The user
   needs to see how changes look *in situ*, not floating in a void. Use
   realistic session titles, realistic numbers of items, realistic spacing.

3. **Be interactive and alive.** Animations must animate. Hover states must
   be hoverable. Transitions must transition. The user should *experience*
   the design, not imagine it from a still frame. This is the key advantage
   of HTML mockups over screenshots.

4. **Show current vs. proposed side by side.** Put the existing behaviour
   next to the proposed change so differences are immediately visible.
   Never show only the proposal — the user needs the baseline to judge
   whether the change is an improvement.

5. **Prove it works across variants.** If the design system has a variable
   axis (e.g. different identity colours via hue-rotate), show 3+ variants
   to demonstrate the proposal works across the full range, not just the
   default. A design that looks great in green but breaks in purple is not
   a good design.

6. **Present 2–3 options when trade-offs exist.** Label each clearly
   (Option A/B/C), write a one-line description of the approach, and mark a
   recommendation with rationale. Let the user choose, but guide them.

7. **Annotate with clear structure.** Use section headings per
   state/component. For each, state: the problem with the current approach,
   what the proposal changes, and why. End with a design rationale section
   that explicitly names the constraints respected (e.g. "colour is identity,
   not state — proposals use animation only").

8. **Respect the design system.** Never violate semantic conventions in
   proposals. If colour means identity, don't repurpose it for state. If a
   palette is reserved for terminal states, don't use it for transient ones.
   Call out these constraints explicitly so the user can verify the mockup
   respects them.

9. **Include a combined view.** After showing individual state comparisons,
   show a full mock of all states coexisting (e.g. a complete sidebar with
   idle, working, starting, and terminated sessions together). This reveals
   whether the states are sufficiently distinct from each other in context.

# Finding 001 — RETRACTED (observer false positive)

**Status**: closed, not a bug.

## What happened

I (the agent) looked at a screenshot showing the same Sandbox question
text appearing twice and concluded the renderer had emitted a duplicate
card. The user clarified: the tab bar (`A. Sandbox · B. Fix scope · C.
Iteration done`) was present in the second card — it was simply scrolled
above the viewport because the multi-question card is tall enough that
the active tab content sits below the tab bar by ~one viewport.

The two visually-similar cards were:
- A previous, smaller `ask_user_choices` posted earlier in the session
  (single question, no tabs).
- The current 3-question ask, with the tab bar clipped off-screen.

Different `tool_use_id`, different content. No duplicate render.

## Lesson for the harness

This is the exact failure mode the mission spec warns about: an observer
flagging something as a bug when the real cause is "I can't see the
whole widget at once". For the observe harness this means:

- DOM-order detection is the trustworthy signal; visual similarity in a
  screenshot is not. The detector at `tests/observe/detectors.ts` is
  already correct (compares fingerprints inside `state.messages`); my
  manual triage stepped outside it.
- When triaging, always cross-check `state.messages.length` and per-widget
  `tool_use_id` before claiming a duplicate. The probe in
  `observer.ts` already records both — use them.

## Possibly worth a separate, smaller finding

The fact that a tall multi-question card can scroll its own tab bar out
of the viewport is mildly disorienting (the user has to scroll up to see
which tab they're on). Not in scope for the message-ordering mission;
filing as a UX nit only if the observe loop independently surfaces a
related complaint.

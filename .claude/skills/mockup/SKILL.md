---
name: mockup
description: Create a high-fidelity interactive HTML design mockup with live preview
argument-hint: <description of what to mock up>
allowed-tools: read, grep, find, ls, write, edit, preview_open, bash
---

# Design Mockup

You are creating a high-fidelity interactive HTML design mockup for: **$ARGUMENTS**

Use the live preview panel by default with `preview_open(html=...)`. Repeated identical preview content may dedupe by content hash and select/update the existing live preview tab; change the content when a distinct restorable mockup is needed.

Use file-backed previews only for existing or reusable HTML artifacts: call `preview_open(file="/absolute/path/to/file.html")` and declare sibling assets with `assets` or `manifest`. Do not write and preview the same mockup through both the inline file-render surface and the live preview surface.

Follow the full design mockup guide below.

@docs/design-mockups.md

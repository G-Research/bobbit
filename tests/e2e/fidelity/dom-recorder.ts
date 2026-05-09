/**
 * DOM recorder — Step 2.
 *
 * Page-side passive witness. Attaches a single MutationObserver to the
 * AgentInterface scroll container and records every visible message-shape
 * change as an ObservedEvent. The recorder NEVER drives the test — it is
 * a witness only.
 *
 * Identity model:
 *   - Stable join key from `data-message-id` attribute (production
 *     renderers set this on <user-message> / <assistant-message> via
 *     their `updated()` hook). Falls back to a positional slot key when
 *     missing, but real production messages always carry an id by the
 *     time they reach the DOM — so the fallback only fires for the
 *     transient empty bubble before its first content render.
 *   - The same logical message can appear under different DOM ancestors
 *     (e.g. <streaming-message-container><assistant-message id=X> while
 *     streaming, then <message-list><assistant-message id=X> once
 *     committed). Joining on `data-message-id` collapses these into one
 *     slot — critical for distinguishing "same logical message moved
 *     between containers" (cosmetic) from "message lost" (real bug).
 *
 * Output: `window.__fidelity__.dump()` returns the full ObservedEvent
 * array. The test harness pulls this back into the test process for the
 * oracle to diff against the script.
 */
export type ObservedEvent =
	| { t: number; kind: "append"; slot: string; role: string; text: string }
	| { t: number; kind: "update"; slot: string; text: string }
	| { t: number; kind: "remove"; slot: string; role: string }
	| { t: number; kind: "status"; status: string }
	| { t: number; kind: "user_send"; text: string };

declare global {
	interface Window {
		__fidelity__?: {
			start: () => void;
			stop: () => void;
			dump: () => ObservedEvent[];
			markUserSend: (text: string) => void;
			/** Clear the events array but RETAIN the slot map. Use between
			 * iterations of a repeat-loop test — the slot map represents
			 * "what's already been observed, count those as the baseline";
			 * the events array is the per-iteration observation window. */
			checkpoint: () => void;
		};
	}
}

const RECORDER_SOURCE = `
(function () {
  if (window.__fidelity__) return;
  const events = [];
  const t0 = performance.now();
  // slot key (data-message-id or fallback) -> last observed text + role + position
  const slotState = new Map();
  let observer = null;
  let statusObserver = null;
  let started = false;

  const MSG_SEL = "user-message, assistant-message, tool-message";
  const SCROLL_SEL = "agent-interface .overflow-y-auto";

  function now() { return Math.round(performance.now() - t0); }

  function textOf(el) {
    // Scope to the message body div, excluding the trailing timestamp span
    // and any LiveTimer pill ('0s'/'1s'/...) that would otherwise look like
    // non-monotone text on every tick.
    const body = el.querySelector(".user-message-container, .assistant-message-container, .tool-message-container")
      || el;
    const clone = body.cloneNode(true);
    // Strip live timers, timestamp spans, blob ornaments — anything that
    // animates orthogonally to message content.
    clone.querySelectorAll("live-timer, .message-timestamp, .live-timer").forEach((n) => n.remove());
    let text = (clone.textContent || "").replace(/\\s+/g, " ").trim();
    // Defensive strip of any leftover "0s"/"12s" timer fragment + locale-time.
    text = text.replace(/\\s*\\d+\\s*s\\s*$/i, "");
    text = text.replace(/\\s*\\d{1,2}:\\d{2}\\s*(?:AM|PM)\\s*$/i, "");
    return text;
  }

  // Per-element identity tracking. We anchor a stable key per DOM
  // element via a WeakMap. data-message-id may arrive after the initial
  // append (Lit updated() runs after connectedCallback); without anchor,
  // the slot would vanish and reappear under a new key (false churn).
  let synthCounter = 0;
  const keyByEl = new WeakMap();
  function keyOf(el, position) {
    let k = keyByEl.get(el);
    if (k) return k;
    const attr = el.getAttribute && el.getAttribute("data-message-id");
    k = attr || ("synth:" + el.tagName.toLowerCase() + ":pos" + position + ":" + (++synthCounter));
    keyByEl.set(el, k);
    return k;
  }

  function snapshotSlots() {
    const nodes = Array.from(document.querySelectorAll(MSG_SEL));
    return nodes.map((el, i) => ({
      key: keyOf(el, i),
      role: el.tagName.toLowerCase().replace("-message", ""),
      text: textOf(el),
      position: i,
    }));
  }

  function diffAndEmit() {
    const snap = snapshotSlots();
    const seen = new Set();
    for (const row of snap) {
      seen.add(row.key);
      const prev = slotState.get(row.key);
      if (!prev) {
        events.push({ t: now(), kind: "append", slot: row.key, role: row.role, text: row.text });
        slotState.set(row.key, { text: row.text, role: row.role, position: row.position });
      } else if (prev.text !== row.text) {
        events.push({ t: now(), kind: "update", slot: row.key, text: row.text });
        slotState.set(row.key, { text: row.text, role: row.role, position: row.position });
      }
    }
    // Detect removals — any previously-recorded slot key that no longer
    // appears in the DOM (and was not just renamed).
    for (const [key, state] of slotState.entries()) {
      if (!seen.has(key)) {
        events.push({ t: now(), kind: "remove", slot: key, role: state.role });
        slotState.delete(key);
      }
    }
  }

  function readStatus() {
    const ra = (window.__bobbitState && window.__bobbitState.remoteAgent)
             || (window.bobbitState && window.bobbitState.remoteAgent);
    if (!ra) return null;
    return (ra._state && ra._state.status) || null;
  }

  function recordStatusIfChanged() {
    const status = readStatus();
    if (!status) return;
    const last = events.filter(e => e.kind === "status").slice(-1)[0];
    if (!last || last.status !== status) {
      events.push({ t: now(), kind: "status", status });
    }
  }

  function observeStatus() {
    // Subscribe to the RemoteAgent's event stream when available — every
    // state mutation goes through emit() so we observe status flips
    // synchronously, even ones that flip back to idle inside the same
    // microtask (the rAF poller misses those). Fall back to rAF polling
    // when the agent isn't ready yet, then upgrade once it is.
    let stopped = false;
    let unsub = null;
    const tryAttach = () => {
      if (stopped || unsub) return;
      const ra = (window.__bobbitState && window.__bobbitState.remoteAgent)
               || (window.bobbitState && window.bobbitState.remoteAgent);
      if (ra && typeof ra.subscribe === "function") {
        unsub = ra.subscribe(() => recordStatusIfChanged());
        // Sample once on attach to seed the first status.
        recordStatusIfChanged();
      }
    };
    const tick = () => {
      if (stopped) return;
      tryAttach();
      recordStatusIfChanged();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    statusObserver = { disconnect: () => {
      stopped = true;
      if (unsub) { try { unsub(); } catch (_e) { /* */ } }
    }};
  }

  window.__fidelity__ = {
    start() {
      if (started) return;
      started = true;
      const root = document.querySelector(SCROLL_SEL) || document.body;
      observer = new MutationObserver(() => { diffAndEmit(); recordStatusIfChanged(); });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      diffAndEmit();
      observeStatus();
    },
    stop() {
      if (!started) return;
      started = false;
      observer?.disconnect();
      statusObserver?.disconnect();
      observer = null;
      statusObserver = null;
    },
    dump() { return events.slice(); },
    markUserSend(text) {
      events.push({ t: now(), kind: "user_send", text: String(text) });
    },
    checkpoint() {
      // Drop all observed events but KEEP slotText so the next diff
      // emits append/update events only for genuinely new content. This
      // is the per-iteration reset for repeat-loop tests.
      events.length = 0;
    },
  };
})();
`;

/** Inject the recorder into the page. Call after the AgentInterface is mounted. */
export async function installRecorder(page: import("@playwright/test").Page): Promise<void> {
	await page.addInitScript({ content: RECORDER_SOURCE });
	// In case the page was already loaded, also inject now.
	await page.evaluate(RECORDER_SOURCE);
	await page.evaluate(() => window.__fidelity__?.start());
}

export async function dumpRecorder(page: import("@playwright/test").Page): Promise<ObservedEvent[]> {
	return await page.evaluate(() => window.__fidelity__?.dump() ?? []);
}

export async function markUserSend(page: import("@playwright/test").Page, text: string): Promise<void> {
	await page.evaluate((t) => window.__fidelity__?.markUserSend(t), text);
}

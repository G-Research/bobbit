// src/app/follow-tail.ts
//
// Scroll-preservation for elements whose content is rewritten by Lit on every
// render (proposal-panel spec preview, edit-mode textarea, etc).
//
// Mirrors docs/internals.md → "Chat scroll lock invariant":
//   - 5px stick-to-bottom tail.
//   - User intent is observed (wheel/touchstart/keydown), never inferred.
//   - Programmatic scrolls filtered via a (scrollTop, scrollHeight) latch
//     consumed exactly once.
//   - delta < 0  → update cached height, do nothing.
//   - delta == 0 → no-op (the canonical vibration-loop fix).
//   - delta > 0  → if stickToBottom, scroll to bottom; else just update cache.

interface LockState {
	stickToBottom: boolean;
	lastScrollHeight: number;
	lastProgScrollTop: number | null;
	lastProgScrollHeight: number | null;
	// Textarea-only: preserved across .value= rewrites.
	selectionStart: number;
	selectionEnd: number;
	attached: boolean;
}

// WeakMap keyed by the scroll element. When Lit detaches and re-attaches
// the same element across renders, the same WeakMap entry is reused — the
// lock state therefore persists across re-renders. When the element is
// permanently removed (panel unmounted), GC reclaims the entry: a fresh
// remount of the same panel starts with a clean {stickToBottom: true,
// lastScrollHeight: 0, …} state. This is the desired invariant.
const locks = new WeakMap<HTMLElement, LockState>();
const TAIL_PX = 5;

function ensureLock(el: HTMLElement): LockState {
	let s = locks.get(el);
	if (!s) {
		s = {
			stickToBottom: true,
			lastScrollHeight: el.scrollHeight,
			lastProgScrollTop: null,
			lastProgScrollHeight: null,
			selectionStart: 0,
			selectionEnd: 0,
			attached: false,
		};
		locks.set(el, s);
	}
	if (!s.attached) {
		attachListeners(el, s);
		s.attached = true;
	}
	return s;
}

function attachListeners(el: HTMLElement, s: LockState) {
	const onScroll = () => {
		if (
			s.lastProgScrollTop !== null &&
			s.lastProgScrollHeight !== null &&
			el.scrollTop === s.lastProgScrollTop &&
			el.scrollHeight === s.lastProgScrollHeight
		) {
			// Consume the programmatic-scroll echo exactly once.
			s.lastProgScrollTop = null;
			s.lastProgScrollHeight = null;
			return;
		}
		s.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_PX;
	};
	const onUserIntent = () => {
		s.stickToBottom = false;
	};
	const onKeydown = (e: KeyboardEvent) => {
		if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(e.key)) {
			s.stickToBottom = false;
		}
	};
	const captureSelection = () => {
		if (el instanceof HTMLTextAreaElement) {
			s.selectionStart = el.selectionStart;
			s.selectionEnd = el.selectionEnd;
		}
	};
	el.addEventListener("scroll", onScroll, { passive: true });
	el.addEventListener("wheel", onUserIntent, { passive: true });
	el.addEventListener("touchstart", onUserIntent, { passive: true });
	el.addEventListener("keydown", onKeydown);
	el.addEventListener("select", captureSelection);
	el.addEventListener("keyup", captureSelection);
	el.addEventListener("click", captureSelection);
}

/**
 * Call AFTER content is rewritten (i.e. after Lit has flushed the new value
 * for this element). Restores scrollTop/selection if we were tracking the
 * tail; otherwise leaves them alone.
 */
export function reconcileFollowTail(el: HTMLElement | null | undefined): void {
	if (!el) return;
	const s = ensureLock(el);
	const newHeight = el.scrollHeight;
	const delta = newHeight - s.lastScrollHeight;

	if (delta < 0) {
		s.lastScrollHeight = newHeight;
		// Restore textarea selection across .value= rewrites even on shrink.
		if (el instanceof HTMLTextAreaElement) {
			try {
				el.setSelectionRange(s.selectionStart, s.selectionEnd);
			} catch {
				/* ignore */
			}
		}
		return;
	}
	if (delta === 0) {
		// critical: vibration-loop fix
		if (el instanceof HTMLTextAreaElement) {
			try {
				el.setSelectionRange(s.selectionStart, s.selectionEnd);
			} catch {
				/* ignore */
			}
		}
		return;
	}

	s.lastScrollHeight = newHeight;
	if (s.stickToBottom) {
		const target = newHeight - el.clientHeight;
		s.lastProgScrollTop = target;
		s.lastProgScrollHeight = newHeight;
		el.scrollTop = newHeight; // browser clamps to target
	}

	// Restore textarea selection across .value= rewrites.
	// Precondition: setSelectionRange only takes visible effect when the
	// textarea is the active element. We still call it unconditionally —
	// the WHATWG spec defines it as a state mutation regardless of focus,
	// so when focus returns the caret is in the right place. We swallow
	// the rare DOMException some browsers throw on detached/hidden inputs.
	if (el instanceof HTMLTextAreaElement) {
		try {
			el.setSelectionRange(s.selectionStart, s.selectionEnd);
		} catch {
			/* ignore */
		}
	}
}

/** Optional explicit cleanup. WeakMap GC handles the common case. */
export function resetFollowTail(el: HTMLElement): void {
	locks.delete(el);
}

// Lazy loader for <message-editor>.
//
// The composer is only rendered for interactive session views. Loading it on
// first render keeps read-only / preparing session paths from paying for the
// editor's attachment, slash-menu, and voice-input UI.

let loaded = false;

export function ensureMessageEditor(): void {
	if (loaded) return;
	loaded = true;
	import("../components/MessageEditor.js").catch((err) => {
		loaded = false;
		console.warn("[message-editor] failed to load component", err);
	});
}

// Fixture panel for the required framework-neutral Host Bobbit sprite API.
// Every visual below is created by the Host and appended as a plain HTMLElement;
// this pack intentionally owns no sprite data, colours, accessories, or animation.
export default function createPanel({ html }) {
	const instances = new Map();
	let nextInstance = 0;

	function createInstance(host, sessionId, staffId) {
		const subjects = [
			["session", { kind: "session", id: sessionId }],
			["staff", { kind: "staff", id: staffId }],
		];
		const presentations = [
			["active", "active", true],
			["idle", "idle", true],
			["paused", "paused", true],
			["active-static", "active", false],
		];
		const sprites = new Map();
		for (const [subjectName, subject] of subjects) {
			for (const [presentation, state, animated] of presentations) {
				const label = `${subjectName === "session" ? "Session" : "Staff"} ${presentation} avatar`;
				const sprite = host.ui.createBobbitSprite({ subject, state, label, animated });
				sprite.dataset.fixtureSprite = `${subjectName}-${presentation}`;
				sprites.set(`${subjectName}-${presentation}`, sprite);
			}
		}
		return { id: `host-sprite-fixture-${++nextInstance}`, sprites };
	}

	function appendSprites(instance) {
		queueMicrotask(() => {
			const panel = document.getElementById(instance.id);
			if (!panel) return;
			for (const [key, sprite] of instance.sprites) {
				const holder = panel.querySelector(`[data-sprite-holder="${key}"]`);
				if (holder && sprite.parentElement !== holder) holder.append(sprite);
			}
			panel.dataset.spritesAppended = "true";
		});
	}

	return {
		render(params, host) {
			const sessionId = String(params?.__sessionId ?? "");
			const staffId = String(params?.staffId ?? "");
			if (!host || !sessionId || !staffId) {
				return html`<section data-testid="host-sprite-fixture-error">Missing bound fixture identity</section>`;
			}
			const key = `${sessionId}:${staffId}`;
			let instance = instances.get(key);
			if (!instance) {
				instance = createInstance(host, sessionId, staffId);
				instances.set(key, instance);
			}
			appendSprites(instance);
			return html`
				<section id=${instance.id} data-testid="host-sprite-fixture-panel" style="padding:1rem;display:grid;gap:1rem;color:var(--foreground);background:var(--background)">
					<header><strong>Host Sprite Fixture</strong></header>
					${["session", "staff"].map(subject => html`
						<section data-sprite-subject=${subject} style="display:grid;gap:.5rem">
							<h3>${subject === "session" ? "Session" : "Staff"}</h3>
							<div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
								${["active", "idle", "paused", "active-static"].map(presentation => html`
									<div data-sprite-holder=${`${subject}-${presentation}`} style="min-width:5rem;min-height:3rem;border:1px solid var(--border);display:flex;align-items:center;justify-content:center"></div>
								`)}
							</div>
						</section>
					`)}
				</section>
			`;
		},
	};
}

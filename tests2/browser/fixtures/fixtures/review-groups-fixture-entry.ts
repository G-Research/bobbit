import "../../../../src/ui/components/review/ReviewDocument.js";
import "../../../../src/ui/components/review/ReviewPane.js";

type ReviewFile = { fileId: string; title: string; markdown: string };
type ReviewGroup = {
	reviewId: string;
	title: string;
	files: ReviewFile[];
	activeFileId: string;
	source: { kind: "markdown-review"; sessionId: string };
};

const SESSION_ID = "review-groups-browser-fixture";
const longTitle = "Overflow Review With A Very Long Primary Workspace Tab Title That Must Truncate";
const groups: ReviewGroup[] = [
	{
		reviewId: "fixture-alpha",
		title: "Alpha Review",
		files: [
			{ fileId: "fixture-alpha-a", title: "Overview.md", markdown: "# Alpha overview\n\nFixture alpha overview body." },
			{ fileId: "fixture-alpha-b", title: "Details.md", markdown: "# Alpha details\n\nFixture alpha details body." },
		],
		activeFileId: "fixture-alpha-a",
		source: { kind: "markdown-review", sessionId: SESSION_ID },
	},
	{
		reviewId: "fixture-overflow",
		title: longTitle,
		files: Array.from({ length: 7 }, (_, index) => ({
			fileId: `fixture-overflow-${index + 1}`,
			title: `Fixture ${index + 1}.md`,
			markdown: `# Fixture ${index + 1}\n\nFixture overflow body ${index + 1}.`,
		})),
		activeFileId: "fixture-overflow-1",
		source: { kind: "markdown-review", sessionId: SESSION_ID },
	},
];

let openGroups = groups.map((group) => ({ ...group, files: group.files.map((file) => ({ ...file })) }));
let selectedReviewId = openGroups[0].reviewId;
let decisions: unknown[] = [];

function installStyles(): void {
	const style = document.createElement("style");
	style.textContent = `
		:root { --background:#fff; --foreground:#111; --card:#fff; --muted-foreground:#666; --border:#bbb; --primary:#315efb; --negative:#b42318; }
		* { box-sizing: border-box; }
		body { margin: 0; color: var(--foreground); background: var(--background); font: 14px system-ui, sans-serif; }
		#review-groups-fixture { width: min(100%, 900px); height: 720px; overflow: hidden; display:flex; flex-direction:column; }
		.fixture-primary-row { min-width:0; display:flex; gap:4px; overflow-x:auto; padding:8px; border-bottom:1px solid var(--border); }
		.goal-tab-pill { min-width:0; max-width:320px; box-sizing:border-box; overflow:hidden; display:flex; flex:0 1 320px; align-items:center; gap:4px; padding:5px 7px; border:1px solid var(--border); border-radius:8px; background:var(--card); color:var(--foreground); cursor:pointer; }
		.goal-tab-pill--active { border-color:var(--primary); }
		.goal-tab-pill-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.goal-tab-close { flex:0 0 24px; width:24px; height:24px; display:grid; place-items:center; border:0; background:transparent; color:inherit; cursor:pointer; }
		review-pane { flex:1; min-height:0; display:block; }
		.hidden { display:none !important; }
	`;
	document.head.appendChild(style);
}

installStyles();
const root = document.createElement("main");
root.id = "review-groups-fixture";
const primary = document.createElement("div");
primary.className = "fixture-primary-row";
primary.setAttribute("data-panel-tab-bar", "true");
const pane = document.createElement("review-pane") as unknown as HTMLElement & { review: ReviewGroup; sessionId: string };
pane.sessionId = SESSION_ID;
pane.addEventListener("review-file-change", (event) => {
	const detail = (event as CustomEvent<{ reviewId: string; fileId: string }>).detail;
	openGroups = openGroups.map((group) => group.reviewId === detail.reviewId ? { ...group, activeFileId: detail.fileId } : group);
	render();
});
pane.addEventListener("review-decision", (event) => {
	event.preventDefault();
	decisions.push((event as CustomEvent).detail);
});
root.append(primary, pane);
document.body.appendChild(root);

function render(): void {
	primary.replaceChildren();
	for (const group of openGroups) {
		const tab = document.createElement("div");
		tab.setAttribute("role", "button");
		tab.tabIndex = 0;
		tab.className = `goal-tab-pill${group.reviewId === selectedReviewId ? " goal-tab-pill--active" : ""}`;
		tab.dataset.panelTabId = `review:${group.reviewId}`;
		tab.dataset.panelTabKind = "review";
		tab.dataset.panelTabTitle = `Review: ${group.title}`;
		tab.title = `Review: ${group.title}`;
		const label = document.createElement("span");
		label.className = "goal-tab-pill-label";
		label.textContent = `Review: ${group.title}`;
		const close = document.createElement("button");
		close.type = "button";
		close.className = "goal-tab-close";
		close.setAttribute("aria-label", `Dismiss Review: ${group.title}`);
		close.textContent = "×";
		tab.append(label, close);
		tab.addEventListener("click", () => { selectedReviewId = group.reviewId; render(); });
		close.addEventListener("click", (event) => {
			event.stopPropagation();
			openGroups = openGroups.filter((candidate) => candidate.reviewId !== group.reviewId);
			if (selectedReviewId === group.reviewId) selectedReviewId = openGroups[0]?.reviewId || "";
			render();
		});
		primary.appendChild(tab);
	}
	const selected = openGroups.find((group) => group.reviewId === selectedReviewId);
	if (!selected) {
		pane.remove();
		return;
	}
	pane.review = selected;
	if (!pane.isConnected) root.appendChild(pane);
}

render();

(window as any).__resetReviewGroupsFixture = () => {
	openGroups = groups.map((group) => ({ ...group, files: group.files.map((file) => ({ ...file })) }));
	selectedReviewId = openGroups[0].reviewId;
	decisions = [];
	render();
};
(window as any).__getReviewGroupsFixtureState = () => ({
	openReviewIds: openGroups.map((group) => group.reviewId),
	selectedReviewId,
	activeFileIds: Object.fromEntries(openGroups.map((group) => [group.reviewId, group.activeFileId])),
	decisions,
});
(window as any).__reviewGroupsFixtureReady = true;

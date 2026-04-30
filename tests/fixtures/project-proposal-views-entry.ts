import { render } from "lit";
import {
	viewTabs,
	componentsView,
	workflowsView,
	diffView,
} from "../../src/app/project-proposal-views.js";

(window as any).renderInto = (id: string, tpl: unknown) => {
	const host = document.getElementById(id);
	if (!host) throw new Error(`no host #${id}`);
	host.innerHTML = "";
	render(tpl as any, host);
};
(window as any).viewTabs = viewTabs;
(window as any).componentsView = componentsView;
(window as any).workflowsView = workflowsView;
(window as any).diffView = diffView;
(window as any).__ready = true;

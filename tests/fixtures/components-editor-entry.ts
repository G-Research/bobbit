import { componentToEditState, editStateToComponent, buildSavePayload } from "../../src/app/components-editor.js";
(window as any).componentToEditState = componentToEditState;
(window as any).editStateToComponent = editStateToComponent;
(window as any).buildSavePayload = buildSavePayload;
(window as any).__ready = true;

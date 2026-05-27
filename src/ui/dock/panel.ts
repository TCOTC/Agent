import type Agent from "../../index";
import {mountAppShell} from "../shell/AppShell";

/** 挂载 Agent 侧栏（Cursor 风格双栏布局） */
export function mountAgentPanel(plugin: Agent, root: HTMLElement): () => void {
    return mountAppShell(plugin, root);
}

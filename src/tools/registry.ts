import type {AgentMode} from "../agent/modes";
import {getModeMeta} from "../agent/modes";
import type {ToolDefinition, ToolRisk} from "../agent/types";
import {allToolDefinitions} from "./catalog";
import {SEMANTIC_SEARCH_BLOCKS_TOOL} from "./semanticSearchGate";

export interface ToolDefinitionsOptions {
    /** 为 false 时不向模型暴露 semantic_search_blocks（默认 false，需先 resolve） */
    semanticSearchEnabled?: boolean;
}

export function getToolDefinitionsForMode(
    mode: AgentMode,
    options?: ToolDefinitionsOptions,
): ToolDefinition[] {
    const meta = getModeMeta(mode);
    if (!meta.enableTools) {
        return [];
    }
    const allowed = new Set(meta.allowedRisks);
    const semanticOn = options?.semanticSearchEnabled === true;
    return allToolDefinitions().filter((t) => {
        if (!allowed.has(t.risk)) {
            return false;
        }
        if (t.name === SEMANTIC_SEARCH_BLOCKS_TOOL && !semanticOn) {
            return false;
        }
        return true;
    });
}

export function toolsToDeepSeekFormat(defs: ToolDefinition[]) {
    return defs.map((d) => ({
        type: "function" as const,
        function: {
            name: d.name,
            description: d.description,
            parameters: d.parameters,
        },
    }));
}

export function getToolByName(name: string): ToolDefinition | undefined {
    return allToolDefinitions().find((d) => d.name === name);
}

export {allToolDefinitions as getToolDefinitions};

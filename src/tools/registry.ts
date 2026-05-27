import type {AgentMode} from "../agent/modes";
import {getModeMeta} from "../agent/modes";
import type {ToolDefinition, ToolRisk} from "../agent/types";
import {allToolDefinitions} from "./catalog";

export function getToolDefinitionsForMode(mode: AgentMode): ToolDefinition[] {
    const meta = getModeMeta(mode);
    if (!meta.enableTools) {
        return [];
    }
    const allowed = new Set(meta.allowedRisks);
    return allToolDefinitions().filter((t) => allowed.has(t.risk));
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

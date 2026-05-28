import type Agent from "../../index";
import type {AuditEvent, KernelExecutor, ToolConfirmRequest, ToolDefinition} from "../../agent/types";
import {getToolDefinitionsForMode} from "./registry";
import {runTool, type ToolRunContext} from "./executor";
import type {AgentMode} from "../../agent/modes";
import type {AgentTool, AgentToolResult} from "../core/agent/types";

export interface AgentToolsContext {
    plugin: Agent;
    kernel: KernelExecutor;
    mode: AgentMode;
    onAudit: (e: AuditEvent) => void;
    requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;
    showDiffPreview?: (html: string, title: string, toolCallId: string) => Promise<boolean>;
    worksetNotebookIds: string[];
    riskAutoApproveMax: number;
    /** 工具 UI 提示回调：toolCallId → hint */
    onToolUiHint?: (toolCallId: string, hint: string) => void;
}

function defToAgentTool(def: ToolDefinition, ctx: AgentToolsContext): AgentTool {
    return {
        name: def.name,
        label: def.name,
        description: def.description,
        parameters: def.parameters,
        executionMode: def.risk === "delete" || def.risk === "write" ? "sequential" : "parallel",
        execute: async (toolCallId, args, _signal, onUpdate) => {
            const toolCtx: ToolRunContext = {
                kernel: ctx.kernel,
                plugin: ctx.plugin,
                onAudit: ctx.onAudit,
                requestConfirm: ctx.requestConfirm,
                worksetNotebookIds: ctx.worksetNotebookIds,
                riskAutoApproveMax: ctx.riskAutoApproveMax,
                showDiffPreview: ctx.showDiffPreview,
                toolCallId,
                skipRiskGate: true,
                onToolUiHint: ctx.onToolUiHint
                    ? (hint) => ctx.onToolUiHint!(toolCallId, hint)
                    : undefined,
            };

            if (onUpdate) {
                onUpdate({
                    content: [{type: "text", text: "执行中…"}],
                    details: {status: "running"},
                });
            }

            const run = await runTool(toolCtx, def.name, JSON.stringify(args ?? {}));
            const result: AgentToolResult = {
                content: [{type: "text", text: run.text}],
                details: {
                    ok: run.ok,
                    riskScore: run.riskScore,
                    autoApproved: run.autoApproved,
                },
            };
            return result;
        },
    };
}

/** 将思源内置 Tool 注册表转为 AgentTool[] */
export function createSiyuanAgentTools(ctx: AgentToolsContext): AgentTool[] {
    return getToolDefinitionsForMode(ctx.mode).map((d) => defToAgentTool(d, ctx));
}

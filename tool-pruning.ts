import { type PluginConfig } from "./config.ts";
import { type DcpMessage } from "./conversation.ts";
import { isFilePathProtected, isToolNameProtected, getFilePathsFromParameters } from "./patterns.ts";
import { countMessageTokens } from "./tokens.ts";
import { type SessionState, type ToolMeta } from "./types.ts";
import { isMessageCompacted } from "./compression-state.ts";

export function buildToolIdList(state: SessionState, messages: DcpMessage[]): string[] {
    const ids: string[] = [];
    for (const entry of messages) {
        if (isMessageCompacted(state, entry) || entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) if (block.type === "toolCall") ids.push(block.id);
    }
    state.toolIdList = ids;
    return ids;
}

export function buildToolMeta(state: SessionState, config: PluginConfig, messages: DcpMessage[]): void {
    state.toolMeta.clear();
    const resultByCallId = new Map<string, DcpMessage>();
    for (const entry of messages) {
        if (entry.message.role === "toolResult") resultByCallId.set(entry.message.toolCallId, entry);
    }

    let turn = 0;
    for (const entry of messages) {
        if (entry.message.role !== "assistant") continue;
        if (isMessageCompacted(state, entry)) continue;
        turn++;
        for (const block of entry.message.content) {
            if (block.type !== "toolCall") continue;
            const result = resultByCallId.get(block.id);
            const status: ToolMeta["status"] = result?.message.role === "toolResult" && result.message.isError
                ? "error"
                : result ? "completed" : "running";
            const tokenCount = toolTokenCount(block, result, status);
            if (config.turnProtection.enabled && state.currentTurn - turn < Math.max(1, config.turnProtection.turns)) {
                state.prune.tools.delete(block.id);
            }
            state.toolMeta.set(block.id, {
                tool: block.name,
                arguments: block.arguments,
                status,
                turn,
                tokenCount,
                assistantEntryId: entry.id,
                resultEntryId: result?.id,
            });
        }
    }
}

function toolTokenCount(
    block: { id: string; name: string; arguments: Record<string, any> },
    result: DcpMessage | undefined,
    status: ToolMeta["status"],
): number {
    const resultContent = result?.message.role === "toolResult" ? result.message.content : [];
    return countMessageTokens({
        role: "toolResult", toolCallId: block.id, toolName: block.name, content: resultContent,
        isError: status === "error", timestamp: 0,
    }) + countMessageTokens({
        role: "assistant", content: [{ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }],
        api: "" as any, provider: "" as any, model: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any,
        stopReason: "stop", timestamp: 0,
    });
}

export function deduplicate(state: SessionState, config: PluginConfig, messages: DcpMessage[]): void {
    if ((state.manualMode && !config.manualMode.automaticStrategies) || !config.strategies.deduplication.enabled) return;
    const signatures = new Map<string, string[]>();
    for (const id of state.toolIdList) {
        if (state.prune.tools.has(id)) continue;
        const meta = state.toolMeta.get(id);
        if (!meta || isToolNameProtected(meta.tool, config.strategies.deduplication.protectedTools)) continue;
        if (isFilePathProtected(getFilePathsFromParameters(meta.tool, meta.arguments), config.protectedFilePatterns)) continue;
        const ids = signatures.get(toolSignature(meta.tool, meta.arguments)) ?? [];
        ids.push(id);
        signatures.set(toolSignature(meta.tool, meta.arguments), ids);
    }
    for (const ids of signatures.values()) {
        for (const id of ids.slice(0, -1)) state.prune.tools.set(id, state.toolMeta.get(id)?.tokenCount ?? 0);
    }
    void messages;
}

export function purgeErrors(state: SessionState, config: PluginConfig, messages: DcpMessage[]): void {
    if ((state.manualMode && !config.manualMode.automaticStrategies) || !config.strategies.purgeErrors.enabled) return;
    const threshold = Math.max(1, config.strategies.purgeErrors.turns);
    for (const id of state.toolIdList) {
        if (state.prune.tools.has(id)) continue;
        const meta = state.toolMeta.get(id);
        if (!meta || meta.status !== "error" || state.currentTurn - meta.turn < threshold) continue;
        if (isToolNameProtected(meta.tool, config.strategies.purgeErrors.protectedTools)) continue;
        if (isFilePathProtected(getFilePathsFromParameters(meta.tool, meta.arguments), config.protectedFilePatterns)) continue;
        state.prune.tools.set(id, meta.tokenCount);
        state.stats.totalPruneTokens += meta.tokenCount;
    }
    void messages;
}

function toolSignature(tool: string, parameters: unknown): string {
    return parameters === undefined ? tool : `${tool}::${JSON.stringify(sortObjectKeys(normalizeParameters(parameters)))}`;
}

function normalizeParameters(parameters: any): any {
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) return parameters;
    return Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null));
}

function sortObjectKeys(value: any): any {
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map(sortObjectKeys);
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
}

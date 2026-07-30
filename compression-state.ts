import { type DcpMessage, findLastCompactionTimestamp, isCompactionSummary } from "./conversation.ts";
import { type Logger } from "./logger.ts";
import { countMessageTokens } from "./tokens.ts";
import { createPruneMessagesState, type CompressionBlock, type SessionState } from "./types.ts";

export function isMessageCompacted(state: SessionState, entry: DcpMessage): boolean {
    return !!entry.id && (isCompactionSummary(entry.message) || (state.prune.messages.byMessageId.get(entry.id)?.activeBlockIds.length ?? 0) > 0);
}

export function countTurns(state: SessionState, messages: DcpMessage[]): number {
    return messages.filter((entry) => entry.message.role === "assistant" && !isMessageCompacted(state, entry)).length;
}

export function resetOnCompaction(state: SessionState): void {
    state.toolMeta.clear();
    state.prune.tools = new Map();
    state.prune.messages = createPruneMessagesState();
    state.messageIds = { byRawId: new Map(), byRef: new Map(), nextRef: 1 };
    state.nudges = { contextLimitAnchors: new Set(), turnNudgeAnchors: new Set(), iterationNudgeAnchors: new Set() };
}

export function getActiveSummaryTokenUsage(state: SessionState): number {
    let total = 0;
    for (const id of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(id);
        if (block?.active) total += block.summaryTokens;
    }
    return total;
}

export function getCurrentTokenUsage(state: SessionState, messages: DcpMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]!.message;
        if (message.role !== "assistant" || !message.usage || (message.usage.output ?? 0) <= 0) continue;
        if (state.lastCompaction > 0 && message.timestamp < state.lastCompaction) return 0;
        const usage = message.usage;
        return (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + (usage.reasoning || 0);
    }
    return 0;
}

export function syncCompressionBlocks(state: SessionState, logger: Logger, messages: DcpMessage[]): void {
    const stored = state.prune.messages;
    if (!stored.blocksById.size) return;
    const present = new Set(messages.map((message) => message.id));
    const activeBefore = new Set(stored.activeBlockIds);
    stored.activeBlockIds.clear();
    stored.activeByAnchorMessageId.clear();
    const now = Date.now();
    for (const block of [...stored.blocksById.values()].sort((a, b) => a.createdAt - b.createdAt || a.blockId - b.blockId)) {
        reconcileBlock(stored, block, present, now);
    }
    refreshMessageBlocks(stored);
    invalidateSplitToolTransactions(state, messages, logger, now);
    if (!sameSet(activeBefore, stored.activeBlockIds)) logger.debug("Synced compression block state", { active: stored.activeBlockIds.size });
}

function reconcileBlock(state: SessionState["prune"]["messages"], block: CompressionBlock, present: Set<string>, now: number): void {
    if (!block.compressMessageId || !present.has(block.compressMessageId) || block.invalidated || block.deactivatedByUser) {
        deactivate(block, now);
        return;
    }
    for (const id of block.consumedBlockIds) {
        if (!state.activeBlockIds.has(id)) continue;
        const consumed = state.blocksById.get(id);
        if (!consumed) continue;
        deactivate(consumed, now, block.blockId);
        state.activeBlockIds.delete(id);
        if (state.activeByAnchorMessageId.get(consumed.anchorMessageId) === id) {
            state.activeByAnchorMessageId.delete(consumed.anchorMessageId);
        }
    }
    block.active = true;
    block.deactivatedAt = undefined;
    block.deactivatedByBlockId = undefined;
    state.activeBlockIds.add(block.blockId);
    if (present.has(block.anchorMessageId)) state.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId);
}

function deactivate(block: CompressionBlock, now: number, byBlockId?: number): void {
    block.active = false;
    block.deactivatedAt ??= now;
    block.deactivatedByBlockId = byBlockId;
}

function refreshMessageBlocks(state: SessionState["prune"]["messages"]): void {
    for (const entry of state.byMessageId.values()) {
        entry.activeBlockIds = entry.allBlockIds.filter((id) => state.activeBlockIds.has(id));
    }
}

function invalidateSplitToolTransactions(state: SessionState, messages: DcpMessage[], logger: Logger, now: number): void {
    const results = new Map<string, DcpMessage>();
    for (const entry of messages) if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry);
    const invalid = new Set<number>();
    for (const assistant of messages) {
        if (!assistant.id || assistant.message.role !== "assistant") continue;
        const assistantBlocks = state.prune.messages.byMessageId.get(assistant.id)?.activeBlockIds ?? [];
        for (const call of assistant.message.content) {
            if (call.type !== "toolCall") continue;
            const result = results.get(call.id);
            if (!result?.id) continue;
            const resultBlocks = state.prune.messages.byMessageId.get(result.id)?.activeBlockIds ?? [];
            if ((assistantBlocks.length > 0) === (resultBlocks.length > 0)) continue;
            assistantBlocks.forEach((id) => invalid.add(id));
            resultBlocks.forEach((id) => invalid.add(id));
        }
    }
    if (!invalid.size) return;
    for (const id of invalid) {
        const block = state.prune.messages.blocksById.get(id);
        if (!block) continue;
        block.invalidated = true;
        deactivate(block, now);
        state.prune.messages.activeBlockIds.delete(id);
        if (state.prune.messages.activeByAnchorMessageId.get(block.anchorMessageId) === id) state.prune.messages.activeByAnchorMessageId.delete(block.anchorMessageId);
    }
    refreshMessageBlocks(state.prune.messages);
    logger.warn("Disabled compression blocks that split tool transactions", { blockIds: [...invalid] });
    void saveQuietly(state, logger);
}

function sameSet(left: Set<number>, right: Set<number>): boolean {
    return left.size === right.size && [...left].every((value) => right.has(value));
}

async function saveQuietly(state: SessionState, logger: Logger): Promise<void> {
    const { saveSessionState } = await import("./persistence.ts");
    await saveSessionState(state, logger);
}

export { findLastCompactionTimestamp, countMessageTokens };

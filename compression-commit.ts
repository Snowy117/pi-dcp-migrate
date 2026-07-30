import type { RangePlan } from "./compression-planner.ts";
import type { MaterializedSummary } from "./compression-summary.ts";
import { countTokens } from "./tokens.ts";
import type { CompressionBlock, SessionState } from "./types.ts";

export interface CompressionCommit {
    blockId: number;
    compressedMessages: number;
}

export function allocateBlockId(state: SessionState): number {
    const current = state.prune.messages.nextBlockId;
    const id = Number.isInteger(current) && current >= 1 ? current : 1;
    state.prune.messages.nextBlockId = id + 1;
    return id;
}

export function allocateRunId(state: SessionState): number {
    const current = state.prune.messages.nextRunId;
    const id = Number.isInteger(current) && current >= 1 ? current : 1;
    state.prune.messages.nextRunId = id + 1;
    return id;
}

export function commitCompression(
    state: SessionState,
    plan: RangePlan,
    materialized: MaterializedSummary,
    runId: number,
    blockId: number,
    mode: "range" | "message",
    batchTopic: string,
    compressMessageId: string,
    compressCallId: string | undefined,
): CompressionCommit {
    const stored = state.prune.messages;
    const consumed = [...new Set(materialized.consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))];
    const messageIds = new Set(plan.selection.messageIds);
    const toolIds = new Set(plan.selection.toolIds);
    for (const id of consumed) {
        const block = stored.blocksById.get(id);
        block?.effectiveMessageIds.forEach((messageId) => messageIds.add(messageId));
        block?.effectiveToolIds.forEach((toolId) => toolIds.add(toolId));
    }
    const block: CompressionBlock = {
        blockId, runId, active: true, deactivatedByUser: false, invalidated: false,
        compressedTokens: 0, summaryTokens: countTokens(materialized.summary), durationMs: 0,
        mode, topic: materialized.topic, batchTopic,
        startId: materialized.startId, endId: materialized.endId,
        anchorMessageId: materialized.anchorMessageId, compressMessageId, compressCallId,
        includedBlockIds: consumed, consumedBlockIds: consumed, parentBlockIds: [],
        directMessageIds: plan.selection.messageIds.filter((id) => messageIds.has(id)),
        directToolIds: plan.selection.toolIds.filter((id) => toolIds.has(id)),
        effectiveMessageIds: [...messageIds], effectiveToolIds: [...toolIds],
        createdAt: Date.now(), summary: materialized.summary,
    };
    stored.blocksById.set(blockId, block);
    stored.activeBlockIds.add(blockId);
    stored.activeByAnchorMessageId.set(materialized.anchorMessageId, blockId);
    deactivateConsumedBlocks(state, consumed, blockId);
    block.compressedTokens = indexCompressedMessages(state, plan, messageIds, blockId);
    state.stats.pruneTokenCounter += block.compressedTokens;
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter;
    state.stats.pruneTokenCounter = 0;
    return { blockId, compressedMessages: plan.selection.messageIds.length };
}

function deactivateConsumedBlocks(state: SessionState, consumed: number[], parentId: number): void {
    for (const id of consumed) {
        const block = state.prune.messages.blocksById.get(id);
        if (!block?.active) continue;
        block.active = false;
        block.deactivatedAt = Date.now();
        block.deactivatedByBlockId = parentId;
        if (!block.parentBlockIds.includes(parentId)) block.parentBlockIds.push(parentId);
        state.prune.messages.activeBlockIds.delete(id);
        if (state.prune.messages.activeByAnchorMessageId.get(block.anchorMessageId) === id) state.prune.messages.activeByAnchorMessageId.delete(block.anchorMessageId);
    }
}

function indexCompressedMessages(state: SessionState, plan: RangePlan, messageIds: Set<string>, blockId: number): number {
    let tokens = 0;
    for (const id of messageIds) {
        const tokenCount = plan.selection.messageTokenById.get(id) ?? 0;
        const existing = state.prune.messages.byMessageId.get(id);
        if (!existing) {
            state.prune.messages.byMessageId.set(id, { tokenCount, allBlockIds: [blockId], activeBlockIds: [blockId] });
            tokens += tokenCount;
            continue;
        }
        existing.tokenCount = Math.max(existing.tokenCount, tokenCount);
        if (!existing.allBlockIds.includes(blockId)) existing.allBlockIds.push(blockId);
        if (!existing.activeBlockIds.length) tokens += tokenCount;
        if (!existing.activeBlockIds.includes(blockId)) existing.activeBlockIds.push(blockId);
    }
    return tokens;
}

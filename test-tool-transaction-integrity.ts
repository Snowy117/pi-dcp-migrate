import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Logger } from "./logger.ts";
import { type DcpMessage, pruneMessages, syncCompressionBlocks } from "./messages.ts";
import { createSessionState, type CompressionBlock } from "./types.ts";

const assistant: AgentMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }],
    api: "x" as any,
    provider: "x" as any,
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any,
    stopReason: "toolUse",
    timestamp: 1,
};
const result: AgentMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "{}" }],
    isError: false,
    timestamp: 2,
};
const compressionCall: AgentMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "compress-1", name: "compress", arguments: {} }],
    api: "x" as any,
    provider: "x" as any,
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any,
    stopReason: "toolUse",
    timestamp: 3,
};
const messages: DcpMessage[] = [
    { id: "assistant-entry", index: 0, ref: "m0001", message: assistant },
    { id: "result-entry", index: 1, ref: "m0002", message: result },
    { id: "compression-entry", index: 2, ref: "m0003", message: compressionCall },
];

const state = createSessionState();
const block: CompressionBlock = {
    blockId: 1,
    runId: 1,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 1,
    summaryTokens: 1,
    durationMs: 0,
    mode: "range" as const,
    topic: "broken legacy state",
    startId: "m0001",
    endId: "m0001",
    anchorMessageId: "assistant-entry",
    compressMessageId: "compression-entry",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: ["assistant-entry"],
    directToolIds: ["call-1"],
    effectiveMessageIds: ["assistant-entry"],
    effectiveToolIds: ["call-1"],
    createdAt: 1,
    summary: "[Compressed conversation section]\nlegacy\n<dcp-message-id>b1</dcp-message-id>",
};
state.prune.messages.blocksById.set(1, block);
state.prune.messages.activeBlockIds.add(1);
state.prune.messages.activeByAnchorMessageId.set("assistant-entry", 1);
state.prune.messages.byMessageId.set("assistant-entry", {
    tokenCount: 1,
    allBlockIds: [1],
    activeBlockIds: [1],
});

const logger = new Logger(false);
syncCompressionBlocks(state, logger, messages);
const pruned = pruneMessages(state, logger, messages);

if (!block.invalidated || block.active || pruned.length !== messages.length) {
    throw new Error("Split tool transaction was not restored from legacy compression state");
}

{
    const replay = createSessionState();
    const child = {
        ...block,
        blockId: 2,
        active: true,
        invalidated: false,
        anchorMessageId: "assistant-entry",
        compressMessageId: "compression-entry",
        consumedBlockIds: [],
    };
    const parent = {
        ...block,
        blockId: 3,
        runId: 2,
        active: true,
        invalidated: false,
        anchorMessageId: "result-entry",
        compressMessageId: "compression-entry",
        consumedBlockIds: [2],
        createdAt: 2,
    };
    replay.prune.messages.blocksById.set(2, child);
    replay.prune.messages.blocksById.set(3, parent);
    replay.prune.messages.activeBlockIds.add(2);
    replay.prune.messages.activeBlockIds.add(3);
    replay.prune.messages.activeByAnchorMessageId.set("assistant-entry", 2);
    replay.prune.messages.activeByAnchorMessageId.set("result-entry", 3);
    syncCompressionBlocks(replay, logger, messages);
    if (replay.prune.messages.activeByAnchorMessageId.has("assistant-entry")) {
        throw new Error("Consumed compression block retained a stale anchor mapping after replay");
    }
}
console.log("TOOL TRANSACTION INTEGRITY TEST PASSED");

import { getConfig } from "./config.ts";
import { createSessionState } from "./types.ts";
import { Logger } from "./logger.ts";
import { assignMessageRefs, buildToolIdList, buildToolMeta, countTurns, deduplicate, type DcpMessage, purgeErrors, syncCompressionBlocks, pruneMessages, injectMessageIdTags } from "./messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { formatBlockRef } from "./compress.ts";

// Given: a conversation we want to compress
const config = getConfig(process.cwd());
const logger = new Logger(false);
const state = createSessionState();
state.sessionKey = "test-range";
state.modelContextLimit = 200000;

const raw: AgentMessage[] = [
    { role: "user", content: "explore the auth module", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "I'll explore auth." }], api: "x" as any, provider: "x" as any, model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any, stopReason: "stop", timestamp: 2 } as any,
    { role: "user", content: "what did you find?", timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "Auth uses JWT with RS256." }], api: "x" as any, provider: "x" as any, model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any, stopReason: "stop", timestamp: 4 } as any,
    { role: "user", content: "now implement login", timestamp: 5 },
];

const dcp: DcpMessage[] = raw.map((m, i) => ({ id: `e${i}`, index: i, message: m }));
state.currentTurn = countTurns(state, dcp);
assignMessageRefs(state, dcp);
syncCompressionBlocks(state, logger, dcp);
buildToolIdList(state, dcp);
buildToolMeta(state, config, dcp);
deduplicate(state, config, dcp);
purgeErrors(state, config, dcp);

// When: a range compression covering e0..e3 is applied
const search = {
    messages: dcp,
    byEntryId: new Map(dcp.map(m => [m.id!, m])),
    summaryByBlockId: new Map(),
};
const startEntry = dcp[0]!;
const endEntry = dcp[3]!;
const messageIds: string[] = [];
for (let i = startEntry.index; i <= endEntry.index; i++) {
    const m = dcp[i]!;
    if (m.id) messageIds.push(m.id);
}

const blockId = state.prune.messages.nextBlockId;
state.prune.messages.nextBlockId = blockId + 1;
const runId = state.prune.messages.nextRunId;
state.prune.messages.nextRunId = runId + 1;
const anchorMessageId = startEntry.id!;
const summary = `[Compressed conversation section]\nAuth exploration: found JWT with RS256.\n\n<dcp-message-id>${formatBlockRef(blockId)}</dcp-message-id>`;

state.prune.messages.blocksById.set(blockId, {
    blockId, runId, active: true, deactivatedByUser: false,
    compressedTokens: 100, summaryTokens: 20, durationMs: 0, mode: "range",
    topic: "Auth Exploration", batchTopic: "Auth Exploration",
    startId: "m0001", endId: "m0004", anchorMessageId,
    compressMessageId: "fake", includedBlockIds: [], consumedBlockIds: [],
    parentBlockIds: [], directMessageIds: messageIds, directToolIds: [],
    effectiveMessageIds: messageIds, effectiveToolIds: [],
    createdAt: Date.now(), summary,
});
state.prune.messages.activeBlockIds.add(blockId);
state.prune.messages.activeByAnchorMessageId.set(anchorMessageId, blockId);
for (const mid of messageIds) {
    state.prune.messages.byMessageId.set(mid, { tokenCount: 50, allBlockIds: [blockId], activeBlockIds: [blockId] });
}

// Then: pruning should collapse the range into a synthetic summary message
const pruned = pruneMessages(state, logger, dcp);
console.log("=== After range compression ===");
console.log("message count:", pruned.length, "(expected: 1 summary + 1 original = 2)");
const summaryMsg = pruned.find(m => m.message.role === "user" && typeof m.message.content === "string" && m.message.content.includes("[Compressed conversation section]"));
console.log("summary injected:", !!summaryMsg);
console.log("summary content:", summaryMsg?.message.role === "user" && typeof summaryMsg.message.content === "string" ? summaryMsg.message.content.slice(0, 80) : null);
const lastUser = pruned.find(m => m.id === "e4");
console.log("last user message preserved:", lastUser?.message.role === "user" && lastUser.message.content === "now implement login");

// Then: the compressed messages e0-e3 are gone
const stillHasE1 = pruned.some(m => m.id === "e1");
console.log("compressed message e1 removed:", !stillHasE1);

if (!summaryMsg || pruned.length !== 2 || stillHasE1) {
    console.error("FAIL");
    process.exit(1);
}
console.log("\nRANGE COMPRESSION TEST PASSED");

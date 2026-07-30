import { allocateBlockId, allocateRunId, commitCompression } from "./compression-commit.ts";
import {
    buildSearchContext,
    effectiveSelectionMessageIds,
    mergeExpandedRangePlans,
    resolveAnchorMessageId,
    resolveBoundary,
    resolveSelection,
    validateCompleteToolTransactions,
    validateNonOverlapping,
    type RangePlan,
} from "./compression-planner.ts";
import { materializePlan, restoreSummary } from "./compression-summary.ts";
import type {
    CompressionRuntime,
    MessageCompressArgs,
    NotifyFn,
    RangeCompressArgs,
} from "./compression-types.ts";
import { isProtectedUserMessage } from "./context-render.ts";
import { parseBoundaryId, type DcpMessage } from "./conversation.ts";

export function runRangeCompress(
    runtime: CompressionRuntime,
    args: RangeCompressArgs,
    messages: DcpMessage[],
    toolCallId: string,
    notify: NotifyFn,
): string {
    if (typeof args.topic !== "string" || !args.topic.trim()) throw new Error("topic is required and must be a non-empty string");
    if (!Array.isArray(args.content) || !args.content.length) throw new Error("content is required and must be a non-empty array");
    const search = buildSearchContext(runtime.state, messages);
    const requested = args.content.map((entry, index): RangePlan => {
        if (typeof entry.startId !== "string" || !entry.startId.trim()) throw new Error(`content[${index}].startId is required`);
        if (typeof entry.endId !== "string" || !entry.endId.trim()) throw new Error(`content[${index}].endId is required`);
        if (typeof entry.summary !== "string" || !entry.summary.trim()) throw new Error(`content[${index}].summary is required`);
        const start = resolveBoundary(search, runtime.state, entry.startId.trim());
        const end = resolveBoundary(search, runtime.state, entry.endId.trim());
        if (start.rawIndex > end.rawIndex) throw new Error(`startId appears after endId in content[${index}]`);
        return {
            selection: resolveSelection(search, start, end),
            anchor: resolveAnchorMessageId(start),
            label: `${entry.startId}..${entry.endId}`,
            start,
            end,
            sources: [{ summary: entry.summary, rawIndex: start.rawIndex, inputIndex: index }],
        };
    });
    const result = compressPlans(runtime, messages, requested, args.topic, "range", toolCallId);
    notifyCompression(runtime, notify, args.topic, result.blockIds, result.total);
    return `Compressed ${result.total} messages into ${result.blockIds.length} ${result.blockIds.length === 1 ? "block" : "blocks"} (${result.blockIds.map((id) => `b${id}`).join(", ")}).`;
}

export function runMessageCompress(
    runtime: CompressionRuntime,
    args: MessageCompressArgs,
    messages: DcpMessage[],
    toolCallId: string,
    notify: NotifyFn,
): string {
    if (typeof args.topic !== "string" || !args.topic.trim()) throw new Error("topic is required");
    if (!Array.isArray(args.content) || !args.content.length) throw new Error("content is required");
    const search = buildSearchContext(runtime.state, messages);
    const requested = args.content.map((entry, index): RangePlan | null => {
        if (typeof entry.messageId !== "string" || !entry.messageId.trim()) throw new Error(`content[${index}].messageId is required`);
        if (typeof entry.summary !== "string" || !entry.summary.trim()) throw new Error(`content[${index}].summary is required`);
        const parsed = parseBoundaryId(entry.messageId.trim());
        if (!parsed || parsed.kind !== "message") throw new Error(`content[${index}].messageId must be a message ID (mNNNN)`);
        const start = resolveBoundary(search, runtime.state, parsed.ref);
        const selection = resolveSelection(search, start, { ...start });
        if (selection.messageIds.length !== 1) throw new Error(`content[${index}] resolves to ${selection.messageIds.length} messages; message mode requires exactly one`);
        const selected = search.byEntryId.get(selection.messageIds[0]!)!;
        if (isProtectedUserMessage(runtime.config, selected)) return null;
        return {
            selection,
            anchor: resolveAnchorMessageId(start),
            label: entry.messageId,
            start,
            end: { ...start },
            sources: [{ summary: entry.summary, rawIndex: start.rawIndex, inputIndex: index, topic: entry.topic || args.topic }],
        };
    }).filter((plan): plan is RangePlan => plan !== null);
    if (!requested.length) {
        notifyCompression(runtime, notify, args.topic, [], 0);
        return "No messages were compressible (they may be protected).";
    }
    const result = compressPlans(runtime, messages, requested, args.topic, "message", toolCallId);
    notifyCompression(runtime, notify, args.topic, result.blockIds, result.total);
    return result.total === 0
        ? "No messages were compressible (they may be protected)."
        : `Compressed ${result.total} messages into ${result.blockIds.length} ${result.blockIds.length === 1 ? "block" : "blocks"}.`;
}

function compressPlans(
    runtime: CompressionRuntime,
    messages: DcpMessage[],
    requested: RangePlan[],
    batchTopic: string,
    mode: "range" | "message",
    toolCallId: string,
): { total: number; blockIds: number[] } {
    validateNonOverlapping(requested);
    const search = buildSearchContext(runtime.state, messages);
    const plans = mergeExpandedRangePlans(runtime.state, search, requested);
    for (const plan of plans) validateCompleteToolTransactions(search, effectiveSelectionMessageIds(runtime.state, plan.selection));
    const runId = allocateRunId(runtime.state);
    const compressMessageId = findCompressMessageId(messages, toolCallId);
    let total = 0;
    const blockIds: number[] = [];
    for (const plan of plans) {
        const blockId = allocateBlockId(runtime.state);
        const materialized = materializePlan(runtime, search, plan, blockId, batchTopic);
        const committed = commitCompression(runtime.state, plan, materialized, runId, blockId, mode, batchTopic, compressMessageId, toolCallId);
        total += committed.compressedMessages;
        blockIds.push(committed.blockId);
    }
    return { total, blockIds };
}

function findCompressMessageId(messages: DcpMessage[], toolCallId: string): string {
    const owner = messages.find((entry) => entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId));
    return owner?.id ?? messages[messages.length - 1]?.id ?? "";
}

function notifyCompression(runtime: CompressionRuntime, notify: NotifyFn, topic: string, blockIds: number[], total: number): void {
    if (runtime.config.pruneNotification === "off" || !blockIds.length) return;
    if (runtime.config.pruneNotification === "minimal") {
        notify(`Compressed ${total} messages (${blockIds.map((id) => `b${id}`).join(", ")})`, "info");
        return;
    }
    const lines = [`Compressed ${total} messages into ${blockIds.length} block(s): ${topic}`];
    if (runtime.config.compress.showCompression) {
        for (const id of blockIds) {
            const block = runtime.state.prune.messages.blocksById.get(id);
            if (block) lines.push(restoreSummary(block.summary).slice(0, 500));
        }
    }
    notify(lines.join("\n"), "info");
}

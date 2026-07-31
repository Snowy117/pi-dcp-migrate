import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    type BoundaryRef,
    expandToolTransactionSelection,
    mergeExpandedRangePlans,
    type RangePlan,
    type SearchContext,
    type Selection,
} from "./compression-planner.ts";
import { runMessageCompress, runRangeCompress } from "./compression-engine.ts";
import { assignMessageRefs, type DcpMessage } from "./conversation.ts";
import { getConfig } from "./config.ts";
import { Logger } from "./logger.ts";
import { createSessionState, type CompressionBlock } from "./types.ts";

function assistant(callIds: string[]): AgentMessage {
    return {
        role: "assistant",
        content: callIds.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.txt` } })),
        api: "test" as any,
        provider: "test" as any,
        model: "test",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } as any,
        stopReason: "toolUse",
        timestamp: 1,
    };
}

function failedAssistant(callIds: string[]): AgentMessage {
    return {
        ...assistant(callIds),
        stopReason: "error",
        errorMessage: "unexpected EOF",
    } as AgentMessage;
}

function stoppedAssistant(callIds: string[], stopReason: "stop" | "length" | "aborted"): AgentMessage {
    return {
        ...assistant(callIds),
        stopReason,
    } as AgentMessage;
}

function result(callId: string): AgentMessage {
    return {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text: callId }],
        isError: false,
        timestamp: 1,
    };
}

function text(value: string): AgentMessage {
    return { role: "user", content: value, timestamp: 1 };
}

function makeMessages(raw: AgentMessage[]): DcpMessage[] {
    return raw.map((message, index) => ({ id: `entry-${index}`, ref: `m${String(index + 1).padStart(4, "0")}`, index, message }));
}

function makeSearch(messages: DcpMessage[]): SearchContext {
    return {
        messages,
        byEntryId: new Map(messages.map((message) => [message.id!, message])),
        summaryByBlockId: new Map(),
    };
}

function boundary(messages: DcpMessage[], index: number): BoundaryRef {
    return { kind: "message", rawIndex: index, entryId: messages[index]!.id };
}

function emptySelection(start: BoundaryRef, end: BoundaryRef): Selection {
    return { start, end, messageIds: [], toolIds: [], messageTokenById: new Map(), requiredBlockIds: [] };
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function makeCompressContext(mode: "range" | "message", messages: DcpMessage[]) {
    const state = createSessionState();
    state.sessionKey = `test-${mode}`;
    assignMessageRefs(state, messages);
    const config = getConfig(process.cwd());
    config.compress.mode = mode;
    config.compress.protectUserMessages = false;
    config.pruneNotification = "off";
    return {
        state,
        ctx: {
            pi: {} as any,
            state,
            config,
            logger: new Logger(false),
            prompts: () => ({} as any),
        },
    };
}

{
    const messages = makeMessages([
        assistant(["call-a", "call-b"]),
        text("between"),
        result("call-b"),
        result("call-a"),
    ]);
    const state = createSessionState();
    const expanded = expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 2), boundary(messages, 2));
    assert(expanded.start.rawIndex === 0, "Selecting one result must include its assistant message");
    assert(expanded.end.rawIndex === 3, "Selecting one result must include every sibling result");
    assert(
        expanded.selection.messageIds.join(",") === "entry-0,entry-1,entry-2,entry-3",
        "Expanded selection must be the full contiguous interval",
    );
}

{
    const messages = makeMessages([
        assistant(["completed-before-error", "abandoned-after-error"]),
        result("completed-before-error"),
        text("continued after partial execution"),
    ]);
    const failed = messages[0]!.message;
    if (failed.role === "assistant") {
        failed.stopReason = "error";
        failed.errorMessage = "stream interrupted";
    }
    const state = createSessionState();
    const expanded = expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 0), boundary(messages, 0));
    assert(expanded.end.rawIndex === 1, "Completed calls from a failed response must retain their tool result");
}

{
    const messages = makeMessages([
        stoppedAssistant(["aborted-call"], "aborted"),
        text("continued after abort"),
    ]);
    const { ctx } = makeCompressContext("range", messages);
    const output = runRangeCompress(ctx, {
        topic: "aborted response recovery",
        content: [{
            startId: "m0001",
            endId: "m0002",
            summary: "The aborted response was abandoned and the conversation continued.",
        }],
    }, messages, "compress-after-abort", () => {});
    assert(output.includes("Compressed 2 messages"), "Aborted tool calls must not permanently block compression");
}

{
    const messages = makeMessages([
        stoppedAssistant(["completed-before-abort", "abandoned-after-abort"], "aborted"),
        result("completed-before-abort"),
        text("continued after partial abort"),
    ]);
    const state = createSessionState();
    const expanded = expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 0), boundary(messages, 0));
    assert(expanded.end.rawIndex === 1, "Completed calls from an aborted response must retain their tool result");
}

for (const [stopReason, callId] of [["stop", "stopped-call"], ["length", "length-limited-call"]] as const) {
    const messages = makeMessages([stoppedAssistant([callId], stopReason)]);
    const state = createSessionState();
    let error = "";
    try {
        expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 0), boundary(messages, 0));
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    }
    assert(
        error.includes("result is not available yet"),
        `${stopReason} responses with resultless tool calls must remain protected as incomplete transactions`,
    );
}

{
    const messages = makeMessages([
        assistant(["outer"]),
        text("between"),
        assistant(["inner"]),
        result("inner"),
        result("outer"),
    ]);
    const state = createSessionState();
    const expanded = expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 0), boundary(messages, 0));
    assert(expanded.end.rawIndex === 4, "Expansion must continue until transactions introduced by the interval are complete");
}

{
    const messages = makeMessages([assistant(["shared"]), text("between"), result("shared")]);
    const state = createSessionState();
    const search = makeSearch(messages);
    const firstStart = boundary(messages, 0);
    const secondStart = boundary(messages, 2);
    const plans: RangePlan[] = [
        {
            start: firstStart,
            end: firstStart,
            selection: emptySelection(firstStart, firstStart),
            anchor: messages[0]!.id!,
            label: "assistant side",
            sources: [{ summary: "assistant summary", rawIndex: 0, inputIndex: 0 }],
        },
        {
            start: secondStart,
            end: secondStart,
            selection: emptySelection(secondStart, secondStart),
            anchor: messages[2]!.id!,
            label: "result side",
            sources: [{ summary: "result summary", rawIndex: 2, inputIndex: 1 }],
        },
    ];
    const merged = mergeExpandedRangePlans(state, search, plans);
    assert(merged.length === 1, "Ranges that overlap after tool transaction expansion must merge");
    assert(merged[0]!.start.rawIndex === 0 && merged[0]!.end.rawIndex === 2, "Merged range must contain both sides");
    assert(merged[0]!.sources.length === 2, "Merged range must retain both caller summaries");
}

{
    const messages = makeMessages([assistant(["pending"])]);
    const state = createSessionState();
    let error = "";
    try {
        expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 0), boundary(messages, 0));
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    }
    assert(error.includes("result is not available yet"), "A selected pending tool call must still fail clearly");
}

{
    const messages = makeMessages([
        text("before failed response"),
        failedAssistant(["abandoned-a", "abandoned-b"]),
        text("continued after retry"),
    ]);
    const { state, ctx } = makeCompressContext("range", messages);
    const output = runRangeCompress(ctx, {
        topic: "failed response recovery",
        content: [{
            startId: "m0001",
            endId: "m0003",
            summary: "The failed assistant response was abandoned and the conversation continued.",
        }],
    }, messages, "compress-after-failed-response", () => {});
    const block = state.prune.messages.blocksById.get(1);
    assert(output.includes("Compressed 3 messages"), "Failed assistant responses must not permanently block later compression");
    assert(
        block?.effectiveMessageIds.join(",") === "entry-0,entry-1,entry-2",
        "Compression must retain the failed assistant response while ignoring its abandoned tool call",
    );
}

{
    const messages = makeMessages([result("orphan")]);
    const state = createSessionState();
    let error = "";
    try {
        expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 0), boundary(messages, 0));
    } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
    }
    assert(error.includes("assistant message is not available"), "An orphan result must fail clearly");
}

{
    const messages = makeMessages([assistant(["duplicate-result"]), result("duplicate-result"), result("duplicate-result")]);
    const state = createSessionState();
    const expanded = expandToolTransactionSelection(state, makeSearch(messages), boundary(messages, 0), boundary(messages, 0));
    assert(expanded.end.rawIndex === 2, "Every result with the selected call ID must be included");
}

{
    const messages = makeMessages([text("old anchor"), assistant(["archived"]), result("archived"), text("recent")]);
    const state = createSessionState();
    const block: CompressionBlock = {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1,
        summaryTokens: 1,
        durationMs: 0,
        mode: "range",
        topic: "archived transaction",
        startId: "m0001",
        endId: "m0003",
        anchorMessageId: messages[0]!.id!,
        compressMessageId: "compress-entry",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [messages[0]!.id!, messages[1]!.id!, messages[2]!.id!],
        directToolIds: ["archived"],
        effectiveMessageIds: [messages[0]!.id!, messages[1]!.id!, messages[2]!.id!],
        effectiveToolIds: ["archived"],
        createdAt: 1,
        summary: "[Compressed conversation section]\narchived\n(dcp-msg-id b1)",
    };
    state.prune.messages.blocksById.set(1, block);
    state.prune.messages.activeBlockIds.add(1);
    state.prune.messages.activeByAnchorMessageId.set(messages[0]!.id!, 1);
    for (const messageId of block.effectiveMessageIds) {
        state.prune.messages.byMessageId.set(messageId, { tokenCount: 1, allBlockIds: [1], activeBlockIds: [1] });
    }
    const search = makeSearch(messages);
    search.summaryByBlockId.set(1, block);
    const expanded = expandToolTransactionSelection(state, search, boundary(messages, 0), boundary(messages, 0));
    assert(expanded.selection.requiredBlockIds.join(",") === "1", "Selecting an active block must retain it for consumption");
    assert(
        expanded.selection.messageIds.join(",") === "entry-0",
        "An active block should remain represented by its anchor until it is consumed",
    );
}

{
    const messages = makeMessages([assistant(["range-call"]), text("range context"), result("range-call"), text("recent")]);
    const { state, ctx } = makeCompressContext("range", messages);
    const output = runRangeCompress(ctx, {
        topic: "range expansion",
        content: [{ startId: "m0001", endId: "m0001", summary: "Range call and intervening context." }],
    }, messages, "compress-range", () => {});
    const block = state.prune.messages.blocksById.get(1);
    assert(output.includes("Compressed 3 messages"), "Range mode must report the automatically expanded message count");
    assert(block?.effectiveMessageIds.join(",") === "entry-0,entry-1,entry-2", "Range mode must store both sides and the expanded span");
    assert(block.summary.includes("Range call and intervening context."), "Range mode must retain the submitted summary");
}

{
    const messages = makeMessages([assistant(["message-call"]), text("message context"), result("message-call"), text("recent")]);
    const { state, ctx } = makeCompressContext("message", messages);
    const output = runMessageCompress(ctx, {
        topic: "message expansion",
        content: [{ messageId: "m0003", topic: "tool result", summary: "Message call and intervening context." }],
    }, messages, "compress-message", () => {});
    const block = state.prune.messages.blocksById.get(1);
    assert(output.includes("Compressed 3 messages"), "Message mode must report the automatically expanded message count");
    assert(block?.effectiveMessageIds.join(",") === "entry-0,entry-1,entry-2", "Message mode must store both sides and the expanded span");
    assert(block.summary.includes("Message call and intervening context."), "Message mode must retain the submitted summary");
}

console.log("TOOL TRANSACTION AUTO-EXPANSION TEST PASSED");

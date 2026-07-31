import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runRangeCompress } from "./compression-engine.ts";
import { getConfig } from "./config.ts";
import { assignMessageRefs, isPiInvisibleMessage, toDcpMessages, type DcpMessage } from "./conversation.ts";
import { Logger } from "./logger.ts";
import { createSessionState } from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function usage() {
    return {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as any;
}

function user(text: string): AgentMessage {
    return { role: "user", content: text, timestamp: 1 };
}

function assistantText(text: string): AgentMessage {
    return {
        role: "assistant", content: [{ type: "text", text }],
        api: "test" as any, provider: "test" as any, model: "test",
        usage: usage(), stopReason: "stop", timestamp: 1,
    };
}

function streamFailedAssistant(callIds: string[], stopReason: "error" | "aborted" = "error"): AgentMessage {
    return {
        role: "assistant",
        content: callIds.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.txt` } })),
        api: "test" as any, provider: "test" as any, model: "test",
        usage: usage(), stopReason, errorMessage: "unexpected EOF", timestamp: 1,
    } as AgentMessage;
}

{
    const raw = [
        user("start"),
        streamFailedAssistant(["gone-a", "gone-b"]),
        streamFailedAssistant(["gone-c"], "aborted"),
        assistantText("visible reply"),
        user("continue"),
    ];
    const entryIds = raw.map((_, index) => `entry-${index}`);
    const messages = toDcpMessages(raw, entryIds);
    assert(messages.length === 3, "Errored and aborted assistant turns must be excluded like pi does");
    assert(messages[0]!.id === "entry-0" && messages[0]!.index === 0, "First visible message keeps its entry id and is re-indexed");
    assert(messages[1]!.id === "entry-3" && messages[1]!.index === 1, "Entry ids must stay paired with their own messages after filtering");
    assert(messages[2]!.id === "entry-4" && messages[2]!.index === 2, "Trailing visible message keeps its entry id");
    assert(!messages.some((entry) => entry.id === "entry-1" || entry.id === "entry-2"), "Filtered entries must not appear");
    assert(isPiInvisibleMessage(raw[1]!) && isPiInvisibleMessage(raw[2]!), "Predicate must match pi's skip rule");
    assert(!isPiInvisibleMessage(raw[3]!), "Normal assistant messages stay visible");
}

{
    const raw = [
        user("review this task"),
        assistantText("I'll read the files."),
        streamFailedAssistant(["call_1", "call_2", "call_3", "call_4", "call_5", "call_6", "call_7", "call_8", "call_9", "call_10"]),
        assistantText("Recovered after the stream error."),
        user("wrap up"),
    ];
    const entryIds = raw.map((_, index) => `session-entry-${index}`);
    const messages: DcpMessage[] = toDcpMessages(raw, entryIds);
    const state = createSessionState();
    state.sessionKey = "pi-invisible-repro";
    assignMessageRefs(state, messages);
    assert(!state.messageIds.byRawId.has("session-entry-2"), "The filtered assistant entry must not receive a message ref");
    const lastRef = state.messageIds.byRawId.get("session-entry-4");
    assert(!!lastRef, "Messages after the filtered entry still get refs");

    const config = getConfig(process.cwd());
    config.compress.protectUserMessages = false;
    config.pruneNotification = "off";
    const ctx = { pi: {} as any, state, config, logger: new Logger(false), prompts: () => ({} as any) };
    const output = runRangeCompress(ctx, {
        topic: "full history",
        content: [{
            startId: "m0001",
            endId: lastRef!,
            summary: "User asked for a review, a stream error interrupted one response, and the conversation recovered.",
        }],
    }, messages, "compress-call", () => {});
    assert(output.includes("Compressed 4 messages"), "Compression over the pi-invisible failed turn must succeed");
    const block = state.prune.messages.blocksById.get(1);
    assert(
        !block?.effectiveMessageIds.includes("session-entry-2"),
        "The pi-invisible errored assistant must not be pulled into the compressed block",
    );
}

console.log("PI-INVISIBLE MESSAGE FILTER TEST PASSED");

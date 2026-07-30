import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getConfig } from "./config.ts";
import {
    assignMessageRefs,
    type DcpMessage,
    injectCompressNudges,
    injectMessageIdTags,
} from "./messages.ts";
import { Logger } from "./logger.ts";
import { createSessionState } from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const toolAssistant: AgentMessage = {
    role: "assistant",
    content: [
        { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.txt" } },
    ],
    api: "test" as any,
    provider: "test" as any,
    model: "test",
    usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as any,
    stopReason: "toolUse",
    timestamp: 1,
};

const messages: DcpMessage[] = [
    { id: "user", index: 0, message: { role: "user", content: "Inspect both files", timestamp: 0 } },
    { id: "assistant", index: 1, message: toolAssistant },
    {
        id: "result-a",
        index: 2,
        message: {
            role: "toolResult",
            toolCallId: "call-a",
            toolName: "read",
            content: [{ type: "text", text: "a" }],
            isError: false,
            timestamp: 2,
        },
    },
    {
        id: "result-b",
        index: 3,
        message: {
            role: "toolResult",
            toolCallId: "call-b",
            toolName: "read",
            content: [{ type: "text", text: "b" }],
            isError: false,
            timestamp: 3,
        },
    },
    { id: "follow-up", index: 4, message: { role: "user", content: "Continue", timestamp: 4 } },
];

const state = createSessionState();
state.modelContextLimit = 1;
assignMessageRefs(state, messages);

const config = getConfig(process.cwd());
config.compress.maxContextLimit = 1_000;
config.compress.minContextLimit = 1;
config.compress.nudgeForce = "soft";

injectMessageIdTags(state, config, messages);
injectCompressNudges(state, config, new Logger(false), messages, {
    system: "",
    contextLimitNudge: "",
    turnNudge: "(dcp-system-reminder\nCompress now.\n)",
    iterationNudge: "",
});

assert(toolAssistant.content.every((block) => block.type === "toolCall"),
    "DCP metadata must not add text after tool calls in an assistant message");
assert(toolAssistant.content.length === 2,
    "DCP metadata must leave the tool-call assistant content unchanged");

const user = messages[0]!.message;
assert(user.role === "user" && typeof user.content === "string" && user.content.includes("(dcp-msg-id m0001)"),
    "Non-tool-call messages must retain their message IDs");

for (const entry of messages.slice(2, 4)) {
    assert(entry.message.role === "toolResult", "Expected tool result fixture");
    const text = entry.message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    assert(text.includes("(dcp-msg-id "),
        "Tool results must retain selectable message IDs");
}

const lastResult = messages[3]!.message;
assert(lastResult.role === "toolResult", "Expected final tool result fixture");
const relocatedMetadata = lastResult.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
assert(!relocatedMetadata.includes("(dcp-msg-id m0002)"),
    "A tool result must not claim the tool-call assistant's message ID");
assert(relocatedMetadata.includes("Compress now."),
    "A nudge anchored to a tool-call assistant must move after its complete tool transaction");

console.log("TOOL CALL METADATA INTEGRITY TEST PASSED");

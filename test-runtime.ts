import { getConfig } from "./config.ts";
import { createSessionState, resetSessionState } from "./types.ts";
import { Logger } from "./logger.ts";
import {
    assignMessageRefs,
    buildToolIdList,
    buildToolMeta,
    countTurns,
    deduplicate,
    type DcpMessage,
    findLastCompactionTimestamp,
    getCurrentTokenUsage,
    injectCompressNudges,
    injectMessageIdTags,
    isIgnoredUserMessage,
    parseBoundaryId,
    pruneMessages,
    purgeErrors,
    syncCompressionBlocks,
    resetOnCompaction,
} from "./messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    buildProtectedToolsExtension,
    CONTEXT_LIMIT_NUDGE,
    ITERATION_NUDGE,
    MANUAL_MODE_SYSTEM_EXTENSION,
    SYSTEM_PROMPT,
    TURN_NUDGE,
} from "./prompts.ts";

function mkUser(text: string, id: string): AgentMessage {
    return { role: "user", content: text, timestamp: Date.now() + Math.random() };
}
function mkAssistant(text: string, id: string, usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 }): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic-messages" as any,
        provider: "anthropic" as any,
        model: "claude-test",
        usage: { ...usage, totalTokens: usage.input + usage.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any,
        stopReason: "stop",
        timestamp: Date.now() + Math.random(),
    } as any;
}
function mkTool(assistantId: string, toolCallId: string, name: string, args: any, output: string, isError = false): { assistant: AgentMessage; result: AgentMessage } {
    const assistant: AgentMessage = {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
        api: "x" as any, provider: "x" as any, model: "m",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any,
        stopReason: "toolUse", timestamp: Date.now() + Math.random(),
    } as any;
    const result: AgentMessage = {
        role: "toolResult", toolCallId, toolName: name,
        content: [{ type: "text", text: output }], isError, timestamp: Date.now() + Math.random(),
    };
    return { assistant, result };
}

const config = getConfig(process.cwd());
const logger = new Logger(true);
const state = createSessionState();
state.sessionKey = "test";
state.modelContextLimit = 200000;

// Given: a conversation with a duplicate tool call and an errored tool call
const raw: AgentMessage[] = [];
raw.push(mkUser("read foo.ts and bar.ts", "u1"));
const t1 = mkTool("a1", "tc1", "read", { path: "foo.ts" }, "export const x = 1;");
raw.push(t1.assistant, t1.result);
const t2 = mkTool("a2", "tc2", "read", { path: "foo.ts" }, "export const x = 1;"); // (intentional duplicate of tc1)
raw.push(t2.assistant, t2.result);
const t3 = mkTool("a3", "tc3", "read", { path: "bar.ts" }, "export const y = 2;");
raw.push(t3.assistant, t3.result);
const t4 = mkTool("a4", "tc4", "bash", { command: "bad-cmd" }, "Error: not found", true);
raw.push(t4.assistant, t4.result);
raw.push(mkAssistant("Done reading files.", "a5"));

const dcp: DcpMessage[] = raw.map((m, i) => ({ id: `e${i}`, index: i, message: m }));

// When: the context pipeline runs
state.currentTurn = countTurns(state, dcp);
assignMessageRefs(state, dcp);
syncCompressionBlocks(state, logger, dcp);
buildToolIdList(state, dcp);
buildToolMeta(state, config, dcp);
deduplicate(state, config, dcp);
purgeErrors(state, config, dcp);

console.log("=== After dedup+purge (turn 0, errors not old enough) ===");
console.log("pruned tool ids:", [...state.prune.tools.keys()]);

// When: enough turns pass for purge-errors to apply
state.toolMeta.get("tc4")!.turn = 0;
state.currentTurn = 10;
purgeErrors(state, config, dcp);
console.log("\n=== After purge-errors (turn 10) ===");
console.log("pruned tool ids:", [...state.prune.tools.keys()]);

const pruned = pruneMessages(state, logger, dcp);
console.log("\n=== Pruned tool output check ===");
const tc1Result = pruned.find(m => m.message.role === "toolResult" && m.message.toolCallId === "tc1");
console.log("tc1 (duplicate) output:", JSON.stringify(tc1Result?.message.role === "toolResult" ? tc1Result.message.content : null));
const tc3Result = pruned.find(m => m.message.role === "toolResult" && m.message.toolCallId === "tc3");
console.log("tc3 (unique) output:", JSON.stringify(tc3Result?.message.role === "toolResult" ? tc3Result.message.content[0] : null));

// Then: message ID tags are injected
injectMessageIdTags(state, config, pruned);
console.log("\n=== Message ID tags ===");
const u1 = pruned.find(m => m.id === "e0");
const hasMessageMarker = u1?.message.role === "user" &&
    typeof u1.message.content === "string" &&
    u1.message.content.includes("(dcp-msg-id m0001)");
console.log("u1 has marker:", hasMessageMarker);
if (!hasMessageMarker) throw new Error("Message ID was not injected with the parenthesized format");

// When: context exceeds the max limit
state.stats = { pruneTokenCounter: 0, totalPruneTokens: 0 };
const overLimitConfig = { ...config, compress: { ...config.compress, maxContextLimit: 10, minContextLimit: 5 } };
injectCompressNudges(state, overLimitConfig, logger, pruned, {
    system: "", contextLimitNudge: "(dcp-system-reminder\nCOMPRESS NOW\n)",
    turnNudge: "", iterationNudge: "",
});
console.log("\n=== Nudge injection ===");
const lastMsg = pruned[pruned.length - 1];
const lastText = lastMsg?.message.role === "assistant" ? lastMsg.message.content.find(c => c.type === "text") : null;
const hasNudge = lastText?.type === "text" && /\(dcp-system-reminder\nCOMPRESS NOW[\s\S]*\n\)/.test(lastText.text);
console.log("last assistant has nudge:", hasNudge);
if (!hasNudge) throw new Error("Context nudge was not injected with the parenthesized format");

const bundledInjections = [
    SYSTEM_PROMPT,
    CONTEXT_LIMIT_NUDGE,
    TURN_NUDGE,
    ITERATION_NUDGE,
    MANUAL_MODE_SYSTEM_EXTENSION,
    buildProtectedToolsExtension(["subagent"]),
];
if (bundledInjections.some(text => /<\/?dcp[\s>]/i.test(text))) {
    throw new Error("Bundled injection prompts must not contain XML-style DCP tags");
}

// Then: boundary IDs parse correctly
console.log("\n=== Boundary parsing ===");
console.log("m0001 ->", JSON.stringify(parseBoundaryId("m0001")));
console.log("b3 ->", JSON.stringify(parseBoundaryId("b3")));
console.log("xyz ->", JSON.stringify(parseBoundaryId("xyz")));

{
    const compressedState = createSessionState();
    const history = [
        mkAssistant("compressed assistant", "old"),
        mkTool("current", "aged-error", "bash", { command: "bad" }, "failed", true).assistant,
        mkTool("current", "aged-error", "bash", { command: "bad" }, "failed", true).result,
        mkAssistant("recent assistant", "recent"),
    ].map((message, index) => ({ id: `compressed-${index}`, index, message }));
    compressedState.prune.messages.byMessageId.set("compressed-0", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    });
    compressedState.currentTurn = countTurns(compressedState, history);
    buildToolIdList(compressedState, history);
    buildToolMeta(compressedState, config, history);
    const meta = compressedState.toolMeta.get("aged-error");
    if (meta?.turn !== 1 || compressedState.currentTurn !== 2) {
        throw new Error(`Tool age coordinates diverged after compression: tool=${meta?.turn}, current=${compressedState.currentTurn}`);
    }
}

console.log("\nALL TESTS PASSED");

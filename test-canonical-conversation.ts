import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runRangeCompress } from "./compression-engine.ts";
import { getConfig } from "./config.ts";
import { Logger } from "./logger.ts";
import {
    buildConversationForTool,
    conversationFromContext,
    reconcileConversation,
} from "./session-runtime.ts";
import { createSessionState } from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function usage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as any;
}

function assistant(text: string, stopReason: "stop" | "error"): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test" as any,
        provider: "test" as any,
        model: "test",
        usage: usage(),
        stopReason,
        errorMessage: stopReason === "error" ? "unexpected EOF" : undefined,
        timestamp: stopReason === "error" ? 2 : 3,
    };
}

const user: AgentMessage = { role: "user", content: "start", timestamp: 1 };
const failed = assistant("partial response", "error");
const recovered = assistant("recovered response", "stop");
const entries = [
    { type: "message", id: "entry-user", parentId: null, timestamp: new Date(1).toISOString(), message: user },
    { type: "message", id: "entry-failed", parentId: "entry-user", timestamp: new Date(2).toISOString(), message: failed },
    { type: "message", id: "entry-recovered", parentId: "entry-failed", timestamp: new Date(3).toISOString(), message: recovered },
] as any[];
let leafId = "entry-recovered";
const ctx = {
    sessionManager: {
        getBranch: () => entries,
        getLeafId: () => leafId,
    },
} as ExtensionContext;

const contextConversation = await conversationFromContext([user, recovered], ctx);
const toolConversation = await buildConversationForTool(ctx);

assert(
    contextConversation.map((entry) => entry.id).join(",") === "entry-user,entry-recovered",
    "Context projection must not shift entry IDs after a Pi-invisible assistant turn",
);
assert(
    toolConversation.map((entry) => entry.id).join(",") === "entry-user,entry-recovered",
    "Tool and context paths must use the same canonical entry identities",
);

const state = createSessionState();
state.sessionKey = "canonical-conversation";
const config = getConfig(process.cwd());
config.compress.protectUserMessages = false;
config.pruneNotification = "off";
const logger = new Logger(false);
reconcileConversation(state, config, logger, toolConversation);
runRangeCompress({ state, config, logger }, {
    topic: "initial history",
    content: [{
        startId: "m0001",
        endId: "m0002",
        summary: "The first request failed transiently and then recovered.",
    }],
}, toolConversation, "first-compress", () => {});

const inserted: AgentMessage = { role: "user", content: "extension-only context", timestamp: 4 };
const projectedWithInsertion = await conversationFromContext(
    [structuredClone(user), inserted, structuredClone(recovered)],
    ctx,
    toolConversation,
);
assert(
    projectedWithInsertion.map((entry) => entry.id).join(",") === "entry-user,,entry-recovered",
    "Unmatched extension messages must stay unbound without shifting canonical IDs",
);

const continued: AgentMessage = { role: "user", content: "continue", timestamp: 5 };
entries.push({
    type: "message",
    id: "entry-continued",
    parentId: "entry-recovered",
    timestamp: new Date(5).toISOString(),
    message: continued,
});
leafId = "entry-continued";
const continuedConversation = await buildConversationForTool(ctx);
reconcileConversation(state, config, logger, continuedConversation);
assert(state.prune.messages.blocksById.get(1)?.active, "Context reconciliation must keep the block active");

const second = runRangeCompress({ state, config, logger }, {
    topic: "continued history",
    content: [{
        startId: "b1",
        endId: "m0003",
        summary: "The recovered conversation continued.",
    }],
}, continuedConversation, "second-compress", () => {});
assert(second.includes("(b2)"), "A block must remain usable as the next compression boundary");

let staleError = "";
try {
    runRangeCompress({ state, config, logger }, {
        topic: "stale boundary",
        content: [{
            startId: "b1",
            endId: "m0003",
            summary: "Retry a stale compressed boundary.",
        }],
    }, continuedConversation, "stale-compress", () => {});
} catch (error) {
    staleError = error instanceof Error ? error.message : String(error);
}
assert(
    staleError.includes("consumed by active block b2; retry with b2") &&
        staleError.includes("Active compressed blocks: b2"),
    "Stale block errors must identify the active successor and current block set",
);

console.log("CANONICAL CONVERSATION TEST PASSED");

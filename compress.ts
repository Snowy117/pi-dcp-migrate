import { Type, type Static } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runMessageCompress, runRangeCompress } from "./compression-engine.ts";
import type { CompressContext, NotifyFn } from "./compression-types.ts";
import { MESSAGE_FORMAT_EXTENSION, RANGE_FORMAT_EXTENSION } from "./prompts.ts";
import { buildConversationForTool, loadStateForSession, reconcileConversation, sessionKeyFor } from "./session-runtime.ts";
import { saveSessionState } from "./persistence.ts";

const RangeSchema = Type.Object({
    topic: Type.String({ description: "Short label (3-5 words) for display - e.g., 'Auth System Exploration'" }),
    content: Type.Array(Type.Object({
        startId: Type.String({ description: "Message or block ID marking the start (e.g. m0001, b2)" }),
        endId: Type.String({ description: "Message or block ID marking the end (e.g. m0012, b5)" }),
        summary: Type.String({ description: "Complete technical summary replacing all content in range" }),
    }), { description: "One or more ranges to compress, each with start/end boundaries and a summary" }),
});

const MessageSchema = Type.Object({
    topic: Type.String({ description: "Short label (3-5 words) for the overall batch" }),
    content: Type.Array(Type.Object({
        messageId: Type.String({ description: "Raw message ID only: mNNNN" }),
        topic: Type.String({ description: "Short label (3-5 words) for this one message summary" }),
        summary: Type.String({ description: "Complete technical summary replacing that one message" }),
    })),
});

export function registerCompressTool(ctx: CompressContext): void {
    if (ctx.config.compress.permission === "deny") return;
    const messageMode = ctx.config.compress.mode === "message";
    const prompts = ctx.prompts();
    ctx.pi.registerTool({
        name: "compress",
        label: "Compress",
        description: (messageMode ? prompts.compressMessage : prompts.compressRange) +
            (messageMode ? MESSAGE_FORMAT_EXTENSION : RANGE_FORMAT_EXTENSION),
        promptSnippet: "Replace stale conversation ranges with technical summaries",
        parameters: messageMode ? MessageSchema : RangeSchema,
        async execute(toolCallId, params, _signal, _onUpdate, execCtx) {
            assertManualPermission(ctx);
            const messages = await buildConversationForTool(execCtx);
            ensureToolSession(ctx, execCtx, messages);
            const notify: NotifyFn = (message, type) => execCtx.ui.notify(message, type);
            const result = messageMode
                ? runMessageCompress(ctx, params as Static<typeof MessageSchema>, messages, toolCallId, notify)
                : runRangeCompress(ctx, params as Static<typeof RangeSchema>, messages, toolCallId, notify);
            ctx.state.manualMode = ctx.state.manualMode ? "active" : false;
            await saveSessionState(ctx.state, ctx.logger);
            return { content: [{ type: "text", text: result }], details: {} };
        },
    });
}

function assertManualPermission(ctx: CompressContext): void {
    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error("Manual mode: compress blocked. Do not retry until `(dcp-compress-triggered-manually)` appears in user context.");
    }
}

function ensureToolSession(ctx: CompressContext, execCtx: ExtensionContext, messages: Parameters<typeof reconcileConversation>[3]): void {
    ctx.state.sessionKey = sessionKeyFor(execCtx);
    reconcileConversation(ctx.state, ctx.config, ctx.logger, messages);
}

export { runMessageCompress, runRangeCompress } from "./compression-engine.ts";
export {
    expandToolTransactionSelection,
    mergeExpandedRangePlans,
    type BoundaryRef,
    type RangePlan,
    type RangePlanSource,
    type SearchContext,
    type Selection,
} from "./compression-planner.ts";
export { formatBlockRef } from "./compression-summary.ts";
export { loadStateForSession, sessionKeyFor } from "./session-runtime.ts";
export type { CompressContext, NotifyFn } from "./compression-types.ts";

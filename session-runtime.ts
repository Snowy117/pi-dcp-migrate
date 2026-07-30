import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PluginConfig } from "./config.ts";
import {
    assignMessageRefs,
    collectConversationEntryIds,
    findLastCompactionTimestamp,
    toDcpMessages,
    type DcpMessage,
} from "./conversation.ts";
import { countTurns, resetOnCompaction, syncCompressionBlocks } from "./compression-state.ts";
import type { Logger } from "./logger.ts";
import { buildToolIdList, buildToolMeta, deduplicate, purgeErrors } from "./tool-pruning.ts";
import type { SessionState } from "./types.ts";

export function sessionKeyFor(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile();
    return file ? file.split("/").pop()!.replace(/\.jsonl$/, "") : ctx.sessionManager.getSessionId() ?? "inmemory";
}

export function reconcileConversation(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: DcpMessage[],
): void {
    const compaction = findLastCompactionTimestamp(messages);
    if (compaction > state.lastCompaction) {
        state.lastCompaction = compaction;
        resetOnCompaction(state);
        logger.info("Detected compaction in context; reset stale state", { timestamp: compaction });
    }
    assignMessageRefs(state, messages);
    syncCompressionBlocks(state, logger, messages);
    state.currentTurn = countTurns(state, messages);
    buildToolIdList(state, messages);
    buildToolMeta(state, config, messages);
    deduplicate(state, config, messages);
    purgeErrors(state, config, messages);
}

export function conversationFromContext(messages: AgentMessage[], ctx: ExtensionContext): DcpMessage[] {
    return toDcpMessages(messages, collectConversationEntryIds(ctx));
}

export async function buildConversationForTool(ctx: ExtensionContext): Promise<DcpMessage[]> {
    const { buildSessionContext } = await import("@earendil-works/pi-coding-agent");
    const entries = ctx.sessionManager.getBranch();
    const built = buildSessionContext(entries, ctx.sessionManager.getLeafId());
    return toDcpMessages(built.messages, collectConversationEntryIds(ctx));
}

export async function loadStateForSession(state: SessionState, ctx: ExtensionContext, logger: Logger): Promise<void> {
    const { loadOrInheritSessionState } = await import("./persistence.ts");
    await loadOrInheritSessionState(state, {
        sessionKey: sessionKeyFor(ctx),
        sessionFile: ctx.sessionManager.getSessionFile(),
        presentEntryIds: () => new Set(ctx.sessionManager.getEntries().map((entry) => entry.id)),
    }, logger);
}

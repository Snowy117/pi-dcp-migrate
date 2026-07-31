import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PluginConfig } from "./config.ts";
import { formatMessageIdTag, isIgnoredUserMessage, type DcpMessage } from "./conversation.ts";
import { isMessageCompacted } from "./compression-state.ts";
import type { Logger } from "./logger.ts";
import { assistantHasToolCall } from "./tool-transactions.ts";
import type { CompressionBlock, SessionState } from "./types.ts";

const PRUNED_TOOL_OUTPUT = "[Output removed to save context - information superseded or no longer needed]";
const PRUNED_ERROR_INPUT = "[input removed due to failed tool call]";

export function isProtectedUserMessage(config: PluginConfig, entry: DcpMessage): boolean {
    return config.compress.mode === "message" && config.compress.protectUserMessages &&
        entry.message.role === "user" && !isIgnoredUserMessage(entry);
}

export function messageHasCompress(entry: DcpMessage): boolean {
    return entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall" && block.name === "compress");
}

export function pruneMessages(state: SessionState, logger: Logger, messages: DcpMessage[]): DcpMessage[] {
    applyToolPruning(state, messages);
    return filterCompressedRanges(state, logger, messages);
}

function applyToolPruning(state: SessionState, messages: DcpMessage[]): void {
    for (const entry of messages) {
        if (!entry.id) continue;
        if (isMessageCompacted(state, entry)) continue;
        const message = entry.message;
        if (message.role === "assistant") {
            let changed = false;
            for (const block of message.content) {
                if (block.type !== "toolCall" || !state.prune.tools.has(block.id)) continue;
                if (state.toolMeta.get(block.id)?.status !== "error") continue;
                block.arguments = Object.fromEntries(Object.entries(block.arguments ?? {}).map(([key, value]) => [
                    key, typeof value === "string" ? PRUNED_ERROR_INPUT : value,
                ]));
                changed = true;
            }
            if (changed) entry.message = { ...message };
        } else if (message.role === "toolResult" && state.prune.tools.has(message.toolCallId)) {
            if (message.toolName !== "edit" && message.toolName !== "write") {
                entry.message = { ...message, content: [{ type: "text", text: PRUNED_TOOL_OUTPUT }] };
            }
        }
    }
}

function filterCompressedRanges(state: SessionState, logger: Logger, messages: DcpMessage[]): DcpMessage[] {
    const stored = state.prune.messages;
    if (!stored.byMessageId.size && !stored.activeByAnchorMessageId.size) return messages;
    const result: DcpMessage[] = [];
    for (const entry of messages) {
        const blockId = entry.id ? stored.activeByAnchorMessageId.get(entry.id) : undefined;
        const block = blockId === undefined ? undefined : stored.blocksById.get(blockId);
        if (block?.active && block.summary) {
            result.push(makeSyntheticSummaryEntry(block));
            logger.debug("Injected compress summary", { anchor: entry.id, blockId });
        }
        if (entry.id && (stored.byMessageId.get(entry.id)?.activeBlockIds.length ?? 0) > 0) continue;
        result.push(entry);
    }
    return result;
}

let syntheticCounter = 0;
function makeSyntheticSummaryEntry(block: CompressionBlock): DcpMessage {
    const message: AgentMessage = { role: "user", content: block.summary, timestamp: block.createdAt || Date.now() };
    return { id: `dcp-summary-${block.blockId}-${++syntheticCounter}`, index: 0, message };
}

export function injectMessageIdTags(state: SessionState, config: PluginConfig, messages: DcpMessage[]): void {
    for (const entry of messages) {
        if (isIgnoredUserMessage(entry) || entry.message.role === "compactionSummary" || assistantHasToolCall(entry)) continue;
        const ref = entry.id ? state.messageIds.byRawId.get(entry.id) : undefined;
        if (!ref) continue;
        injectIntoMessage(entry, formatMessageIdTag(isProtectedUserMessage(config, entry) ? "BLOCKED" : ref));
    }
}

export function injectIntoMessage(entry: DcpMessage, text: string): void {
    if (!text.trim()) return;
    const message = entry.message;
    if (message.role === "user") {
        if (typeof message.content === "string") {
            message.content = appendText(message.content, text);
            return;
        }
        if (Array.isArray(message.content)) injectTextBlock(message.content, text);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
        if (!assistantHasToolCall(entry)) injectTextBlock(message.content, text);
    } else if (message.role === "toolResult" && Array.isArray(message.content)) {
        message.content.push({ type: "text", text: text.trim() });
    }
}

function injectTextBlock(content: Array<any>, text: string): void {
    for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index];
        if (block?.type !== "text" || typeof block.text !== "string") continue;
        block.text = appendText(block.text, text);
        return;
    }
    content.push({ type: "text", text: text.trim() });
}

function appendText(existing: string, added: string): string {
    return `${existing.replace(/\n*$/, "")}\n\n${added.trim()}`;
}

export function stripHallucinations(text: string): string {
    return text
        .replace(/<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi, "")
        .replace(/<\/?dcp[^>]*>/gi, "")
        .replace(/\(dcp-system-reminder\b[\s\S]*?\n\)/gi, "")
        .replace(/\(dcp-msg-id\s+[^)\r\n]+\)/gi, "")
        .replace(/\(dcp-compress-triggered-manually\)/gi, "")
        .trim();
}

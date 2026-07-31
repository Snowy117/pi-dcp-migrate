import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "./types.ts";

export interface DcpMessage {
    id: string;
    index: number;
    message: AgentMessage;
    ref?: string;
}

const MESSAGE_REF_REGEX = /^m(\d{4})$/;
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/;
export const MESSAGE_REF_MAX_INDEX = 9999;
const MESSAGE_REF_WIDTH = 4;

export type ParsedBoundaryId =
    | { kind: "message"; ref: string; index: number }
    | { kind: "compressed-block"; ref: string; blockId: number };

export function formatMessageRef(index: number): string {
    return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`;
}

export function parseMessageRef(ref: string): number | null {
    const match = ref.trim().toLowerCase().match(MESSAGE_REF_REGEX);
    if (!match) return null;
    const index = Number.parseInt(match[1]!, 10);
    return index >= 1 && index <= MESSAGE_REF_MAX_INDEX ? index : null;
}

export function parseBlockRef(ref: string): number | null {
    const match = ref.trim().toLowerCase().match(BLOCK_REF_REGEX);
    if (!match) return null;
    const id = Number.parseInt(match[1]!, 10);
    return Number.isInteger(id) ? id : null;
}

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
    const index = parseMessageRef(id);
    if (index !== null) return { kind: "message", ref: formatMessageRef(index), index };
    const blockId = parseBlockRef(id);
    return blockId === null ? null : { kind: "compressed-block", ref: `b${blockId}`, blockId };
}

export function formatMessageIdTag(ref: string): string {
    return `\n(dcp-msg-id ${ref})`;
}

/**
 * Return session-entry IDs in exactly the order used by pi's context builder.
 * Both context rendering and the compress tool use this one mapping.
 */
export function collectConversationEntryIds(ctx: ExtensionContext): string[] {
    return collectEntryIds(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
}

export function collectEntryIds(entries: Array<{ id: string; parentId?: string | null; type: string; summary?: unknown; firstKeptEntryId?: string }>, leafId: string | null): string[] {
    if (leafId === null || !entries.length) return [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    let current = leafId ? byId.get(leafId) : entries[entries.length - 1];
    if (!current) current = entries[entries.length - 1];
    if (!current) return [];

    const path: typeof entries = [];
    while (current) {
        path.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    path.reverse();

    const compaction = [...path].reverse().find((entry) => entry.type === "compaction");
    const ids: string[] = [];
    const push = (entry: (typeof entries)[number]) => {
        if (entry.type === "message" || entry.type === "custom_message") ids.push(entry.id);
        if (entry.type === "branch_summary" && entry.summary) ids.push(entry.id);
    };

    if (!compaction) {
        path.forEach(push);
        return ids;
    }

    ids.push(compaction.id);
    const compactionIndex = path.indexOf(compaction);
    let kept = false;
    for (let index = 0; index < compactionIndex; index++) {
        const entry = path[index]!;
        if (entry.id === compaction.firstKeptEntryId) kept = true;
        if (kept) push(entry);
    }
    for (let index = compactionIndex + 1; index < path.length; index++) push(path[index]!);
    return ids;
}

export function toDcpMessages(messages: AgentMessage[], entryIds: string[]): DcpMessage[] {
    const visible: DcpMessage[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        if (isPiInvisibleMessage(message)) continue;
        visible.push({ id: entryIds[index] ?? `ctx-${index}`, index: visible.length, message });
    }
    return visible;
}

export function isPiInvisibleMessage(message: AgentMessage): boolean {
    return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

export function assignMessageRefs(state: SessionState, messages: DcpMessage[]): number {
    let assigned = 0;
    for (const entry of messages) {
        if (!entry.id) continue;
        const existing = state.messageIds.byRawId.get(entry.id);
        if (existing) {
            entry.ref = existing;
            if (state.messageIds.byRef.get(existing) !== entry.id) state.messageIds.byRef.set(existing, entry.id);
            continue;
        }
        const ref = allocateMessageRef(state);
        state.messageIds.byRawId.set(entry.id, ref);
        state.messageIds.byRef.set(ref, entry.id);
        entry.ref = ref;
        assigned++;
    }
    return assigned;
}

function allocateMessageRef(state: SessionState): string {
    let candidate = Number.isInteger(state.messageIds.nextRef) ? Math.max(1, state.messageIds.nextRef) : 1;
    while (candidate <= MESSAGE_REF_MAX_INDEX) {
        const ref = formatMessageRef(candidate);
        if (!state.messageIds.byRef.has(ref)) {
            state.messageIds.nextRef = candidate + 1;
            return ref;
        }
        candidate++;
    }
    return formatMessageRef(MESSAGE_REF_MAX_INDEX);
}

export function isCompactionSummary(message: AgentMessage): boolean {
    return message.role === "compactionSummary";
}

export function findLastCompactionTimestamp(messages: DcpMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]!.message;
        if (isCompactionSummary(message)) return message.timestamp;
    }
    return 0;
}

export function isIgnoredUserMessage(entry: DcpMessage): boolean {
    if (entry.message.role !== "user") return false;
    const { content } = entry.message;
    if (typeof content === "string") return content.trim().length === 0;
    return !Array.isArray(content) || !content.length || content.every((block) => block.type !== "text" || !block.text?.trim());
}

import type { CompressionBlock, SessionState } from "./types.ts";
import {
    isCompactionSummary,
    isIgnoredUserMessage,
    parseBoundaryId,
    type DcpMessage,
} from "./conversation.ts";
import { countMessageTokens } from "./tokens.ts";
import { buildToolTransactionIndex } from "./tool-transactions.ts";

export interface BoundaryRef {
    kind: "message" | "compressed-block";
    rawIndex: number;
    entryId?: string;
    blockId?: number;
    anchorMessageId?: string;
}

export interface SearchContext {
    messages: DcpMessage[];
    byEntryId: Map<string, DcpMessage>;
    summaryByBlockId: Map<number, CompressionBlock>;
}

export interface Selection {
    start: BoundaryRef;
    end: BoundaryRef;
    messageIds: string[];
    toolIds: string[];
    messageTokenById: Map<string, number>;
    requiredBlockIds: number[];
}

export interface RangePlanSource {
    summary: string;
    rawIndex: number;
    inputIndex: number;
    topic?: string;
}

export interface RangePlan {
    selection: Selection;
    anchor: string;
    label: string;
    start: BoundaryRef;
    end: BoundaryRef;
    sources: RangePlanSource[];
}

export function buildSearchContext(state: SessionState, messages: DcpMessage[]): SearchContext {
    const byEntryId = new Map(messages.filter((message) => message.id).map((message) => [message.id, message]));
    const summaryByBlockId = new Map<number, CompressionBlock>();
    for (const [id, block] of state.prune.messages.blocksById) if (block.active) summaryByBlockId.set(id, block);
    return { messages, byEntryId, summaryByBlockId };
}

export function resolveBoundary(search: SearchContext, state: SessionState, id: string): BoundaryRef {
    const parsed = parseBoundaryId(id);
    if (!parsed) throw new Error(`Invalid boundary ID: ${id}. Use an injected message ID (mNNNN) or block ID (bN).`);
    if (parsed.kind === "message") {
        const entryId = state.messageIds.byRef.get(parsed.ref);
        const message = entryId ? search.byEntryId.get(entryId) : undefined;
        if (!entryId || !message) throw new Error(`${parsed.ref} is not available in the current context.`);
        return { kind: "message", rawIndex: message.index, entryId };
    }
    const block = search.summaryByBlockId.get(parsed.blockId);
    const anchor = block ? search.byEntryId.get(block.anchorMessageId) : undefined;
    if (!block || !anchor) throw new Error(`Compressed block ${parsed.ref} is not available in the current context.`);
    return { kind: "compressed-block", rawIndex: anchor.index, blockId: block.blockId, anchorMessageId: block.anchorMessageId };
}

export function resolveSelection(search: SearchContext, start: BoundaryRef, end: BoundaryRef): Selection {
    const messageIds: string[] = [];
    const toolIds: string[] = [];
    const seenMessages = new Set<string>();
    const seenTools = new Set<string>();
    const messageTokenById = new Map<string, number>();
    for (let index = start.rawIndex; index <= end.rawIndex; index++) {
        const entry = search.messages[index];
        if (!entry?.id || isIgnoredUserMessage(entry) || isCompactionSummary(entry.message)) continue;
        if (!seenMessages.has(entry.id)) {
            seenMessages.add(entry.id);
            messageIds.push(entry.id);
        }
        messageTokenById.set(entry.id, messageTokenById.get(entry.id) ?? countMessageTokens(entry.message));
        if (entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
            if (block.type === "toolCall" && !seenTools.has(block.id)) {
                seenTools.add(block.id);
                toolIds.push(block.id);
            }
        }
    }
    if (!messageIds.length) throw new Error("Failed to map boundary matches back to messages. Choose boundaries that include original conversation messages.");
    return { start, end, messageIds, toolIds, messageTokenById, requiredBlockIds: requiredBlocks(search, messageIds) };
}

function requiredBlocks(search: SearchContext, messageIds: string[]): number[] {
    const selected = new Set(messageIds);
    return [...search.summaryByBlockId.values()]
        .filter((block) => selected.has(block.anchorMessageId))
        .map((block) => ({ id: block.blockId, index: search.byEntryId.get(block.anchorMessageId)?.index ?? Number.MAX_SAFE_INTEGER }))
        .sort((left, right) => left.index - right.index || left.id - right.id)
        .map(({ id }) => id);
}

export function effectiveSelectionMessageIds(state: SessionState, selection: Selection): string[] {
    const ids = new Set(selection.messageIds);
    for (const blockId of selection.requiredBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId);
        if (block?.active) block.effectiveMessageIds.forEach((id) => ids.add(id));
    }
    return [...ids];
}

export function validateCompleteToolTransactions(search: SearchContext, selectedMessageIds: Iterable<string>): void {
    const selected = new Set(selectedMessageIds);
    const index = buildToolTransactionIndex(search.messages);
    const issues: string[] = [];
    for (const assistant of search.messages) {
        if (!assistant.id || assistant.message.role !== "assistant") continue;
        const assistantSelected = selected.has(assistant.id);
        for (const call of assistant.message.content) {
            if (call.type !== "toolCall") continue;
            const owners = index.assistantsByCallId.get(call.id) ?? [];
            if (owners.length > 1 && (assistantSelected || owners.some((owner) => selected.has(owner.id)))) {
                issues.push(`tool call ${call.id} belongs to multiple assistant messages`);
                continue;
            }
            const results = index.resultsByCallId.get(call.id) ?? [];
            if (!results.length && assistantSelected) issues.push(`${assistant.ref ?? assistant.id} contains tool call ${call.id}, whose result is not available yet`);
            for (const result of results) {
                if (result.id && assistantSelected !== selected.has(result.id)) {
                    issues.push(`${assistant.ref ?? assistant.id} and ${result.ref ?? result.id} are the two sides of tool call ${call.id}`);
                }
            }
        }
    }
    for (const result of search.messages) {
        if (!result.id || result.message.role !== "toolResult" || !selected.has(result.id)) continue;
        if (!(index.assistantsByCallId.get(result.message.toolCallId)?.length)) {
            issues.push(`${result.ref ?? result.id} is a result for tool call ${result.message.toolCallId}, whose assistant message is not available`);
        }
    }
    if (issues.length) throw new Error("Compression could not include complete tool transactions automatically:\n" + issues.map((issue) => `- ${issue}`).join("\n"));
}

export function expandToolTransactionSelection(
    state: SessionState,
    search: SearchContext,
    initialStart: BoundaryRef,
    initialEnd: BoundaryRef,
): { start: BoundaryRef; end: BoundaryRef; selection: Selection } {
    const transactions = buildToolTransactionIndex(search.messages);
    let start = initialStart;
    let end = initialEnd;
    while (true) {
        const selection = resolveSelection(search, start, end);
        const selected = new Set(effectiveSelectionMessageIds(state, selection));
        const required = new Set<DcpMessage>();
        for (const id of selected) {
            const entry = search.byEntryId.get(id);
            if (!entry) continue;
            if (entry.message.role === "assistant") {
                for (const call of entry.message.content) {
                    if (call.type !== "toolCall") continue;
                    const owners = transactions.assistantsByCallId.get(call.id) ?? [];
                    if (owners.length > 1) throw new Error(`Tool call ${call.id} belongs to multiple assistant messages.`);
                    const results = transactions.resultsByCallId.get(call.id) ?? [];
                    if (!results.length) throw new Error(`${entry.ref ?? entry.id} contains tool call ${call.id}, whose result is not available yet.`);
                    for (const result of results) if (!selected.has(result.id)) includeEntryOrBlockAnchor(state, search, result, required);
                }
            } else if (entry.message.role === "toolResult") {
                const owners = transactions.assistantsByCallId.get(entry.message.toolCallId) ?? [];
                if (!owners.length) throw new Error(`${entry.ref ?? entry.id} is a result for tool call ${entry.message.toolCallId}, whose assistant message is not available.`);
                if (owners.length > 1) throw new Error(`Tool call ${entry.message.toolCallId} belongs to multiple assistant messages.`);
                if (!selected.has(owners[0]!.id)) includeEntryOrBlockAnchor(state, search, owners[0]!, required);
            }
        }
        const nextStart = Math.min(start.rawIndex, ...[...required].map((entry) => entry.index));
        const nextEnd = Math.max(end.rawIndex, ...[...required].map((entry) => entry.index));
        if (nextStart === start.rawIndex && nextEnd === end.rawIndex) {
            validateCompleteToolTransactions(search, effectiveSelectionMessageIds(state, selection));
            return { start, end, selection };
        }
        if (nextStart < start.rawIndex) start = boundaryForMessage(search.messages[nextStart]!);
        if (nextEnd > end.rawIndex) end = boundaryForMessage(search.messages[nextEnd]!);
    }
}

function includeEntryOrBlockAnchor(state: SessionState, search: SearchContext, entry: DcpMessage, required: Set<DcpMessage>): void {
    const active = entry.id ? state.prune.messages.byMessageId.get(entry.id)?.activeBlockIds ?? [] : [];
    let represented = false;
    for (const id of active) {
        const block = state.prune.messages.blocksById.get(id);
        const anchor = block?.active ? search.byEntryId.get(block.anchorMessageId) : undefined;
        if (anchor) { required.add(anchor); represented = true; }
    }
    if (!represented) required.add(entry);
}

function boundaryForMessage(entry: DcpMessage): BoundaryRef {
    if (!entry.id) throw new Error("Failed to map tool transaction back to a session message");
    return { kind: "message", rawIndex: entry.index, entryId: entry.id };
}

export function resolveAnchorMessageId(ref: BoundaryRef): string {
    const id = ref.kind === "compressed-block" ? ref.anchorMessageId : ref.entryId;
    if (!id) throw new Error("Failed to map boundary matches back to messages");
    return id;
}

export function expandRangePlan(state: SessionState, search: SearchContext, plan: RangePlan): RangePlan {
    const expanded = expandToolTransactionSelection(state, search, plan.start, plan.end);
    return { ...plan, ...expanded, anchor: resolveAnchorMessageId(expanded.start) };
}

export function mergeExpandedRangePlans(state: SessionState, search: SearchContext, initialPlans: RangePlan[]): RangePlan[] {
    let plans = initialPlans.map((plan) => expandRangePlan(state, search, plan));
    while (true) {
        plans.sort((left, right) => left.start.rawIndex - right.start.rawIndex || left.end.rawIndex - right.end.rawIndex);
        const merged: RangePlan[] = [];
        let changed = false;
        for (const plan of plans) {
            const previous = merged[merged.length - 1];
            if (!previous || plan.start.rawIndex > previous.end.rawIndex) { merged.push(plan); continue; }
            changed = true;
            const start = previous.start.rawIndex <= plan.start.rawIndex ? previous.start : plan.start;
            const end = previous.end.rawIndex >= plan.end.rawIndex ? previous.end : plan.end;
            merged[merged.length - 1] = expandRangePlan(state, search, { ...previous, start, end, label: `${previous.label} + ${plan.label}`, sources: [...previous.sources, ...plan.sources] });
        }
        plans = merged;
        if (!changed) return plans;
    }
}

export function validateNonOverlapping(plans: Array<{ start: BoundaryRef; end: BoundaryRef; label: string }>): void {
    const sorted = [...plans].sort((left, right) => left.start.rawIndex - right.start.rawIndex || left.end.rawIndex - right.end.rawIndex);
    const issues: string[] = [];
    for (let index = 1; index < sorted.length; index++) {
        if (sorted[index]!.start.rawIndex <= sorted[index - 1]!.end.rawIndex) issues.push(`${sorted[index - 1]!.label} overlaps ${sorted[index]!.label}. Overlapping ranges cannot be compressed in the same batch.`);
    }
    if (issues.length) throw new Error(issues.map((issue) => `- ${issue}`).join("\n"));
}

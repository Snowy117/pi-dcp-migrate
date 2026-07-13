import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PluginConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import {
    type CompressionBlock,
    type SessionState,
} from "./types.ts";
import { applyPersistedState, saveSessionState } from "./persistence.ts";
import {
    assignMessageRefs,
    buildToolIdList,
    buildToolMeta,
    deduplicate,
    type DcpMessage,
    findLastCompactionTimestamp,
    formatMessageIdTag,
    formatMessageRef,
    isCompactionSummary,
    isIgnoredUserMessage,
    isMessageCompacted,
    isProtectedUserMessage,
    parseBoundaryId,
    purgeErrors,
    resetOnCompaction,
} from "./messages.ts";
import { countMessageTokens, countTokens } from "./tokens.ts";
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "./patterns.ts";
import {
    MESSAGE_FORMAT_EXTENSION,
    RANGE_FORMAT_EXTENSION,
    type RuntimePrompts,
} from "./prompts.ts";

const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]";

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export interface CompressContext {
    pi: ExtensionAPI;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    prompts: () => RuntimePrompts;
}

const RangeSchema = Type.Object({
    topic: Type.String({ description: "Short label (3-5 words) for display - e.g., 'Auth System Exploration'" }),
    content: Type.Array(
        Type.Object({
            startId: Type.String({ description: "Message or block ID marking the start (e.g. m0001, b2)" }),
            endId: Type.String({ description: "Message or block ID marking the end (e.g. m0012, b5)" }),
            summary: Type.String({ description: "Complete technical summary replacing all content in range" }),
        }),
        { description: "One or more ranges to compress, each with start/end boundaries and a summary" },
    ),
});

const MessageSchema = Type.Object({
    topic: Type.String({ description: "Short label (3-5 words) for the overall batch" }),
    content: Type.Array(
        Type.Object({
            messageId: Type.String({ description: "Raw message ID only: mNNNN" }),
            topic: Type.String({ description: "Short label (3-5 words) for this one message summary" }),
            summary: Type.String({ description: "Complete technical summary replacing that one message" }),
        }),
    ),
});

export function registerCompressTool(ctx: CompressContext): void {
    if (ctx.config.compress.permission === "deny") return;

    const isMessageMode = ctx.config.compress.mode === "message";
    const prompts = ctx.prompts();
    const description = (isMessageMode ? prompts.compressMessage : prompts.compressRange) +
        (isMessageMode ? MESSAGE_FORMAT_EXTENSION : RANGE_FORMAT_EXTENSION);

    ctx.pi.registerTool({
        name: "compress",
        label: "Compress",
        description,
        promptSnippet: "Replace stale conversation ranges with technical summaries",
        parameters: isMessageMode ? MessageSchema : RangeSchema,
        async execute(toolCallId, params, _signal, _onUpdate, execCtx) {
            if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
                throw new Error(
                    "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
                );
            }

            const { messages, entryIds } = await buildSessionForTool(ctx, execCtx);
            const dcpMessages = toDcpMessages(messages, entryIds);
            await ensureSession(ctx, execCtx, dcpMessages);

            const notify: NotifyFn = (message, type) => execCtx.ui.notify(message, type);
            if (isMessageMode) {
                const result = runMessageCompress(ctx, params as Static<typeof MessageSchema>, dcpMessages, toolCallId, notify);
                await finalize(ctx, execCtx);
                return { content: [{ type: "text", text: result }], details: {} };
            }
            const result = runRangeCompress(ctx, params as Static<typeof RangeSchema>, dcpMessages, toolCallId, notify);
            await finalize(ctx, execCtx);
            return { content: [{ type: "text", text: result }], details: {} };
        },
    });
}

async function buildSessionForTool(ctx: CompressContext, execCtx: ExtensionContext): Promise<{ messages: AgentMessage[]; entryIds: string[] }> {
    const { buildSessionContext } = await import("@earendil-works/pi-coding-agent");
    const entries = execCtx.sessionManager.getBranch();
    const built = buildSessionContext(entries, execCtx.sessionManager.getLeafId());
    const leafIds = collectEntryIdsForBranch(entries, execCtx.sessionManager.getLeafId());
    return { messages: built.messages, entryIds: leafIds };
}

function collectEntryIdsForBranch(entries: any[], leafId: string | null): string[] {
    const byId = new Map<string, any>();
    for (const entry of entries) byId.set(entry.id, entry);
    let leaf: any;
    if (leafId === null) return [];
    if (leafId) leaf = byId.get(leafId);
    if (!leaf) leaf = entries[entries.length - 1];
    if (!leaf) return [];

    const path: any[] = [];
    let current: any = leaf;
    while (current) {
        path.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    path.reverse();

    let compaction: any;
    for (const e of path) if (e.type === "compaction") compaction = e;

    const ids: string[] = [];
    const push = (e: any) => {
        if (e.type === "message") ids.push(e.id);
        else if (e.type === "custom_message") ids.push(e.id);
        else if (e.type === "branch_summary" && e.summary) ids.push(e.id);
    };
    if (compaction) {
        ids.push(compaction.id);
        const idx = path.findIndex((e) => e.id === compaction.id);
        let found = false;
        for (let i = 0; i < idx; i++) {
            if (path[i]!.id === compaction.firstKeptEntryId) found = true;
            if (found) push(path[i]!);
        }
        for (let i = idx + 1; i < path.length; i++) push(path[i]!);
    } else {
        for (const e of path) push(e);
    }
    return ids;
}

function toDcpMessages(messages: AgentMessage[], entryIds: string[]): DcpMessage[] {
    const out: DcpMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        out.push({ id: entryIds[i] ?? `ctx-${i}`, index: i, message: messages[i]! });
    }
    return out;
}

async function ensureSession(ctx: CompressContext, execCtx: ExtensionContext, messages: DcpMessage[]): Promise<void> {
    const sessionKey = sessionKeyFor(execCtx);
    if (ctx.state.sessionKey !== sessionKey) {
        ctx.state.sessionKey = sessionKey;
    }
    const lastCompaction = findLastCompactionTimestamp(messages);
    if (lastCompaction > ctx.state.lastCompaction) {
        ctx.state.lastCompaction = lastCompaction;
        resetOnCompaction(ctx.state);
    }
    ctx.state.currentTurn = countAssistantTurns(ctx.state, messages);
    assignMessageRefs(ctx.state, messages);
    buildToolIdList(ctx.state, messages);
    buildToolMeta(ctx.state, ctx.config, messages);
    deduplicate(ctx.state, ctx.config, messages);
    purgeErrors(ctx.state, ctx.config, messages);
}

function countAssistantTurns(state: SessionState, messages: DcpMessage[]): number {
    let n = 0;
    for (const m of messages) {
        if (isMessageCompacted(state, m)) continue;
        if (m.message.role === "assistant") n++;
    }
    return n;
}

async function finalize(ctx: CompressContext, execCtx: ExtensionContext): Promise<void> {
    ctx.state.manualMode = ctx.state.manualMode ? "active" : false;
    await saveSessionState(ctx.state, ctx.logger);
    void execCtx;
}

interface BoundaryRef {
    kind: "message" | "compressed-block";
    rawIndex: number;
    entryId?: string;
    blockId?: number;
    anchorMessageId?: string;
}

interface SearchContext {
    messages: DcpMessage[];
    byEntryId: Map<string, DcpMessage>;
    summaryByBlockId: Map<number, CompressionBlock>;
}

function buildSearchContext(state: SessionState, messages: DcpMessage[]): SearchContext {
    const byEntryId = new Map<string, DcpMessage>();
    for (const m of messages) if (m.id) byEntryId.set(m.id, m);
    const summaryByBlockId = new Map<number, CompressionBlock>();
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (block.active) summaryByBlockId.set(blockId, block);
    }
    return { messages, byEntryId, summaryByBlockId };
}

function resolveBoundary(ctx: SearchContext, state: SessionState, id: string): BoundaryRef {
    const parsed = parseBoundaryId(id);
    if (!parsed) throw new Error(`Invalid boundary ID: ${id}. Use an injected message ID (mNNNN) or block ID (bN).`);

    if (parsed.kind === "message") {
        const entryId = state.messageIds.byRef.get(parsed.ref);
        if (!entryId) throw new Error(`${parsed.ref} is not available in the current context.`);
        const msg = ctx.byEntryId.get(entryId);
        if (!msg) throw new Error(`${parsed.ref} is not available in the current context.`);
        return { kind: "message", rawIndex: msg.index, entryId };
    }

    const block = ctx.summaryByBlockId.get(parsed.blockId);
    if (!block) throw new Error(`Compressed block ${parsed.ref} is not available in the current context.`);
    const anchor = ctx.byEntryId.get(block.anchorMessageId);
    if (!anchor) throw new Error(`Compressed block ${parsed.ref} is not available in the current context.`);
    return { kind: "compressed-block", rawIndex: anchor.index, blockId: block.blockId, anchorMessageId: block.anchorMessageId };
}

interface Selection {
    start: BoundaryRef;
    end: BoundaryRef;
    messageIds: string[];
    toolIds: string[];
    messageTokenById: Map<string, number>;
    requiredBlockIds: number[];
}

function effectiveSelectionMessageIds(state: SessionState, selection: Selection): string[] {
    const ids = new Set(selection.messageIds);
    for (const blockId of selection.requiredBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId);
        if (!block?.active) continue;
        for (const id of block.effectiveMessageIds) ids.add(id);
    }
    return [...ids];
}

function validateCompleteToolTransactions(
    search: SearchContext,
    selectedMessageIds: Iterable<string>,
): void {
    const selected = new Set(selectedMessageIds);
    const resultsByCallId = new Map<string, DcpMessage>();
    for (const entry of search.messages) {
        if (entry.message.role === "toolResult") resultsByCallId.set(entry.message.toolCallId, entry);
    }

    const issues: string[] = [];
    for (const assistant of search.messages) {
        if (!assistant.id || assistant.message.role !== "assistant") continue;
        const assistantSelected = selected.has(assistant.id);
        for (const block of assistant.message.content) {
            if (block.type !== "toolCall") continue;
            const result = resultsByCallId.get(block.id);
            if (!result?.id) {
                if (assistantSelected) {
                    issues.push(`${assistant.ref ?? assistant.id} contains tool call ${block.id}, whose result is not available yet`);
                }
                continue;
            }
            const resultSelected = selected.has(result.id);
            if (assistantSelected === resultSelected) continue;
            issues.push(
                `${assistant.ref ?? assistant.id} and ${result.ref ?? result.id} are the two sides of tool call ${block.id}`,
            );
        }
    }

    if (issues.length) {
        throw new Error(
            "Compression cannot split a tool call from its result. Expand or shrink the selected ranges so each tool transaction is included in full:\n" +
            issues.map((issue) => `- ${issue}`).join("\n"),
        );
    }
}

function resolveSelection(ctx: SearchContext, start: BoundaryRef, end: BoundaryRef): Selection {
    const messageIds: string[] = [];
    const seen = new Set<string>();
    const toolIds: string[] = [];
    const toolSeen = new Set<string>();
    const messageTokenById = new Map<string, number>();

    for (let i = start.rawIndex; i <= end.rawIndex; i++) {
        const msg = ctx.messages[i];
        if (!msg || !msg.id) continue;
        if (isIgnoredUserMessage(msg)) continue;
        if (isCompactionSummary(msg.message)) continue;
        if (!seen.has(msg.id)) {
            seen.add(msg.id);
            messageIds.push(msg.id);
        }
        if (!messageTokenById.has(msg.id)) messageTokenById.set(msg.id, countMessageTokens(msg.message));
        if (msg.message.role === "assistant") {
            for (const block of msg.message.content) {
                if (block.type === "toolCall" && !toolSeen.has(block.id)) {
                    toolSeen.add(block.id);
                    toolIds.push(block.id);
                }
            }
        }
    }

    const selected = new Set(messageIds);
    const requiredBlockIds: number[] = [];
    const blockSeen = new Set<number>();
    const anchored: Array<{ blockId: number; rawIndex: number }> = [];
    for (const block of ctx.summaryByBlockId.values()) {
        if (!selected.has(block.anchorMessageId)) continue;
        const anchorMsg = ctx.byEntryId.get(block.anchorMessageId);
        if (!anchorMsg) continue;
        anchored.push({ blockId: block.blockId, rawIndex: anchorMsg.index });
    }
    anchored.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId);
    for (const { blockId } of anchored) {
        if (!blockSeen.has(blockId)) {
            blockSeen.add(blockId);
            requiredBlockIds.push(blockId);
        }
    }

    if (!messageIds.length) {
        throw new Error("Failed to map boundary matches back to messages. Choose boundaries that include original conversation messages.");
    }
    return { start, end, messageIds, toolIds, messageTokenById, requiredBlockIds };
}

function resolveAnchorMessageId(ref: BoundaryRef): string {
    if (ref.kind === "compressed-block") {
        if (!ref.anchorMessageId) throw new Error("Failed to map boundary matches back to messages");
        return ref.anchorMessageId;
    }
    if (!ref.entryId) throw new Error("Failed to map boundary matches back to messages");
    return ref.entryId;
}

function validateNonOverlapping(plans: Array<{ start: BoundaryRef; end: BoundaryRef; label: string }>): void {
    const sorted = [...plans].sort((a, b) => a.start.rawIndex - b.start.rawIndex || a.end.rawIndex - b.end.rawIndex);
    const issues: string[] = [];
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (cur.start.rawIndex > prev.end.rawIndex) continue;
        issues.push(`${prev.label} overlaps ${cur.label}. Overlapping ranges cannot be compressed in the same batch.`);
    }
    if (issues.length) throw new Error(issues.map((i) => `- ${i}`).join("\n"));
}

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi;

function injectBlockPlaceholders(
    summary: string,
    requiredBlockIds: number[],
    start: BoundaryRef,
    end: BoundaryRef,
    summaryByBlockId: Map<number, CompressionBlock>,
): { expanded: string; consumed: number[] } {
    const consumed: number[] = [];
    const consumedSeen = new Set<number>();
    const placeholders: Array<{ raw: string; blockId: number; start: number; end: number }> = [];
    const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(summary)) !== null) {
        const id = Number.parseInt(match[1] || match[2] || "", 10);
        if (!Number.isInteger(id)) continue;
        placeholders.push({ raw: match[0], blockId: id, start: match.index, end: match.index + match[0].length });
    }

    const required = new Set(requiredBlockIds);
    let expanded = summary;
    if (placeholders.length) {
        expanded = "";
        let cursor = 0;
        for (const ph of placeholders) {
            if (!summaryByBlockId.has(ph.blockId) || !required.has(ph.blockId) || consumedSeen.has(ph.blockId)) {
                continue;
            }
            const target = summaryByBlockId.get(ph.blockId)!;
            expanded += summary.slice(cursor, ph.start);
            expanded += restoreSummary(target.summary);
            cursor = ph.end;
            consumedSeen.add(ph.blockId);
            consumed.push(ph.blockId);
        }
        expanded += summary.slice(cursor);
    }

    for (const ref of [start, end]) {
        if (ref.kind !== "compressed-block" || ref.blockId === undefined || consumedSeen.has(ref.blockId)) continue;
        const target = summaryByBlockId.get(ref.blockId);
        if (!target) throw new Error(`Compressed block not found: (b${ref.blockId})`);
        const body = restoreSummary(target.summary).trim();
        expanded = !expanded.trim() ? body : !body ? expanded.trim() : `${expanded.trim()}\n\n${body}`;
        consumedSeen.add(ref.blockId);
        consumed.push(ref.blockId);
    }

    const missing = [...required].filter((id) => !consumedSeen.has(id));
    if (missing.length) {
        const parts = missing.map((id) => {
            const target = summaryByBlockId.get(id);
            if (!target) throw new Error(`Compressed block not found: (b${id})`);
            consumed.push(id);
            return `\n### (b${id})\n${restoreSummary(target.summary)}`;
        });
        expanded += "\n\nThe following previously compressed summaries were also part of this conversation section:" + parts.join("");
    }

    return { expanded, consumed };
}

function restoreSummary(summary: string): string {
    const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i);
    if (!headerMatch) return summary;
    const after = summary.slice(headerMatch[0].length).replace(/^(?:\r?\n)+/, "");
    return after.replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "").replace(/(?:\r?\n)+$/, "");
}

function wrapSummary(blockId: number, summary: string): string {
    const body = summary.trim();
    const footer = formatMessageIdTag(formatBlockRef(blockId));
    return body.length === 0 ? `${COMPRESSED_BLOCK_HEADER}\n${footer}` : `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n${footer}`;
}

export function formatBlockRef(blockId: number): string {
    return `b${blockId}`;
}

function appendProtectedContent(
    ctx: CompressContext,
    selection: Selection,
    search: SearchContext,
    summary: string,
): string {
    const { config, state } = ctx;
    let result = summary;

    if (config.compress.protectUserMessages) {
        const userTexts: string[] = [];
        for (const msgId of selection.messageIds) {
            if (state.prune.messages.byMessageId.get(msgId)?.activeBlockIds.length) continue;
            const msg = search.byEntryId.get(msgId);
            if (!msg || msg.message.role !== "user" || isIgnoredUserMessage(msg)) continue;
            const text = typeof msg.message.content === "string"
                ? msg.message.content
                : msg.message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
            if (text.trim()) userTexts.push(text);
        }
        if (userTexts.length) {
            result += "\n\nThe following user messages were sent in this conversation verbatim:" + userTexts.map((t) => `\n${t}`).join("");
        }
    }

    if (config.compress.protectTags) {
        const protectedTexts: string[] = [];
        for (const msgId of selection.messageIds) {
            if (state.prune.messages.byMessageId.get(msgId)?.activeBlockIds.length) continue;
            const msg = search.byEntryId.get(msgId);
            if (!msg || msg.message.role !== "user") continue;
            const text = typeof msg.message.content === "string" ? msg.message.content : "";
            for (const m of text.matchAll(/<protect>([\s\S]*?)<\/protect>/gi)) {
                const t = m[1]?.trim();
                if (t) protectedTexts.push(t);
            }
        }
        if (protectedTexts.length) {
            result += "\n\nThe following protected prompt information was included in this conversation verbatim:" + protectedTexts.map((t) => `\n${t}`).join("");
        }
    }

    const protectedTools = config.compress.protectedTools;
    const protectedOutputs: string[] = [];
    for (const msgId of selection.messageIds) {
        if (state.prune.messages.byMessageId.get(msgId)?.activeBlockIds.length) continue;
        const msg = search.byEntryId.get(msgId);
        if (!msg || msg.message.role !== "toolResult") continue;
        const meta = state.toolMeta.get(msg.message.toolCallId);
        const toolName = msg.message.toolName;
        let isProtected = isToolNameProtected(toolName, protectedTools);
        if (!isProtected && protectedFilePatterns_for(config, meta)) {
            isProtected = true;
        }
        if (!isProtected) continue;
        const output = msg.message.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        if (output) protectedOutputs.push(`\n### Tool: ${toolName}\n${output}`);
    }
    if (protectedOutputs.length) {
        result += "\n\nThe following protected tools were used in this conversation as well:" + protectedOutputs.join("");
    }

    return result;
}

function protectedFilePatterns_for(config: PluginConfig, meta: { tool: string; arguments: any } | undefined): boolean {
    if (!config.protectedFilePatterns.length || !meta) return false;
    const filePaths = getFilePathsFromParameters(meta.tool, meta.arguments);
    return isFilePathProtected(filePaths, config.protectedFilePatterns);
}

function allocateBlockId(state: SessionState): number {
    const next = state.prune.messages.nextBlockId;
    state.prune.messages.nextBlockId = Number.isInteger(next) && next >= 1 ? next + 1 : 2;
    return Number.isInteger(next) && next >= 1 ? next : 1;
}

function allocateRunId(state: SessionState): number {
    const next = state.prune.messages.nextRunId;
    state.prune.messages.nextRunId = Number.isInteger(next) && next >= 1 ? next + 1 : 2;
    return Number.isInteger(next) && next >= 1 ? next : 1;
}

function applyCompression(
    state: SessionState,
    runId: number,
    topic: string,
    selection: Selection,
    anchorMessageId: string,
    compressMessageId: string,
    compressCallId: string | undefined,
    blockId: number,
    storedSummary: string,
    consumedBlockIds: number[],
): number {
    const messagesState = state.prune.messages;
    const consumed = [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))];
    const effectiveMessageIds = new Set(selection.messageIds);
    const effectiveToolIds = new Set(selection.toolIds);

    for (const id of consumed) {
        const block = messagesState.blocksById.get(id);
        if (!block) continue;
        for (const mid of block.effectiveMessageIds) effectiveMessageIds.add(mid);
        for (const tid of block.effectiveToolIds) effectiveToolIds.add(tid);
    }

    const block: CompressionBlock = {
        blockId,
        runId,
        active: true,
        deactivatedByUser: false,
        invalidated: false,
        compressedTokens: 0,
        summaryTokens: countTokens(storedSummary),
        durationMs: 0,
        mode: "range",
        topic,
        batchTopic: topic,
        startId: "",
        endId: "",
        anchorMessageId,
        compressMessageId,
        compressCallId,
        includedBlockIds: [...consumed],
        consumedBlockIds: consumed,
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        createdAt: Date.now(),
        summary: storedSummary,
    };

    messagesState.blocksById.set(blockId, block);
    messagesState.activeBlockIds.add(blockId);
    messagesState.activeByAnchorMessageId.set(anchorMessageId, blockId);

    for (const id of consumed) {
        const consumedBlock = messagesState.blocksById.get(id);
        if (!consumedBlock || !consumedBlock.active) continue;
        consumedBlock.active = false;
        consumedBlock.deactivatedAt = Date.now();
        consumedBlock.deactivatedByBlockId = blockId;
        if (!consumedBlock.parentBlockIds.includes(blockId)) consumedBlock.parentBlockIds.push(blockId);
        messagesState.activeBlockIds.delete(id);
        if (messagesState.activeByAnchorMessageId.get(consumedBlock.anchorMessageId) === id) {
            messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId);
        }
    }

    let compressedTokens = 0;
    for (const messageId of effectiveMessageIds) {
        const tokenCount = selection.messageTokenById.get(messageId) || 0;
        const existing = messagesState.byMessageId.get(messageId);
        if (!existing) {
            messagesState.byMessageId.set(messageId, {
                tokenCount,
                allBlockIds: [blockId],
                activeBlockIds: [blockId],
            });
            compressedTokens += tokenCount;
        } else {
            existing.tokenCount = Math.max(existing.tokenCount, tokenCount);
            if (!existing.allBlockIds.includes(blockId)) existing.allBlockIds.push(blockId);
            if (existing.activeBlockIds.length === 0) compressedTokens += tokenCount;
            if (!existing.activeBlockIds.includes(blockId)) existing.activeBlockIds.push(blockId);
        }
    }

    block.directMessageIds = [...effectiveMessageIds].filter((id) => selection.messageIds.includes(id));
    block.directToolIds = [...effectiveToolIds].filter((id) => selection.toolIds.includes(id));
    block.compressedTokens = compressedTokens;

    state.stats.pruneTokenCounter += compressedTokens;
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter;
    state.stats.pruneTokenCounter = 0;

    return selection.messageIds.length;
}

function runRangeCompress(ctx: CompressContext, args: Static<typeof RangeSchema>, messages: DcpMessage[], toolCallId: string, notify: NotifyFn): string {
    if (typeof args.topic !== "string" || !args.topic.trim()) throw new Error("topic is required and must be a non-empty string");
    if (!Array.isArray(args.content) || !args.content.length) throw new Error("content is required and must be a non-empty array");

    const search = buildSearchContext(ctx.state, messages);
    const plans = args.content.map((entry, index) => {
        if (typeof entry.startId !== "string" || !entry.startId.trim()) throw new Error(`content[${index}].startId is required`);
        if (typeof entry.endId !== "string" || !entry.endId.trim()) throw new Error(`content[${index}].endId is required`);
        if (typeof entry.summary !== "string" || !entry.summary.trim()) throw new Error(`content[${index}].summary is required`);
        const start = resolveBoundary(search, ctx.state, entry.startId.trim());
        const end = resolveBoundary(search, ctx.state, entry.endId.trim());
        if (start.rawIndex > end.rawIndex) throw new Error(`startId appears after endId in content[${index}]`);
        const selection = resolveSelection(search, start, end);
        return { entry, selection, anchor: resolveAnchorMessageId(start), label: `${entry.startId}..${entry.endId}`, start, end };
    });

    validateNonOverlapping(plans);
    validateCompleteToolTransactions(
        search,
        plans.flatMap((plan) => effectiveSelectionMessageIds(ctx.state, plan.selection)),
    );

    const runId = allocateRunId(ctx.state);
    let total = 0;
    const blockIds: number[] = [];
    for (const plan of plans) {
        const { expanded, consumed } = injectBlockPlaceholders(
            plan.entry.summary,
            plan.selection.requiredBlockIds,
            plan.start,
            plan.end,
            search.summaryByBlockId,
        );
        const withProtected = appendProtectedContent(ctx, plan.selection, search, expanded);
        const blockId = allocateBlockId(ctx.state);
        const stored = wrapSummary(blockId, withProtected);
        const count = applyCompression(
            ctx.state,
            runId,
            args.topic,
            plan.selection,
            plan.anchor,
            messages[messages.length - 1]?.id ?? "",
            toolCallId,
            blockId,
            stored,
            consumed,
        );
        total += count;
        blockIds.push(blockId);
    }

    notifyCompression(ctx, notify, args.topic, blockIds, total);
    return `Compressed ${total} messages into ${blockIds.length} ${blockIds.length === 1 ? "block" : "blocks"} (${blockIds.map((b) => `b${b}`).join(", ")}).`;
}

function runMessageCompress(ctx: CompressContext, args: Static<typeof MessageSchema>, messages: DcpMessage[], toolCallId: string, notify: NotifyFn): string {
    if (typeof args.topic !== "string" || !args.topic.trim()) throw new Error("topic is required");
    if (!Array.isArray(args.content) || !args.content.length) throw new Error("content is required");

    const search = buildSearchContext(ctx.state, messages);
    const plans = args.content.map((entry, index) => {
        if (typeof entry.messageId !== "string" || !entry.messageId.trim()) throw new Error(`content[${index}].messageId is required`);
        if (typeof entry.summary !== "string" || !entry.summary.trim()) throw new Error(`content[${index}].summary is required`);

        const parsed = parseBoundaryId(entry.messageId.trim());
        if (!parsed || parsed.kind !== "message") throw new Error(`content[${index}].messageId must be a message ID (mNNNN)`);
        const start = resolveBoundary(search, ctx.state, parsed.ref);
        const selection = resolveSelection(search, start, { ...start });
        if (selection.messageIds.length !== 1) {
            throw new Error(`content[${index}] resolves to ${selection.messageIds.length} messages; message mode requires exactly one`);
        }
        return { entry, selection, start };
    });
    validateCompleteToolTransactions(
        search,
        plans.flatMap((plan) => effectiveSelectionMessageIds(ctx.state, plan.selection)),
    );

    const runId = allocateRunId(ctx.state);
    let total = 0;
    const blockIds: number[] = [];

    for (const { entry, selection, start } of plans) {
        const protectedOk = isProtectedUserMessage(ctx.config, search.byEntryId.get(selection.messageIds[0]!)!);
        if (protectedOk) continue;

        const withProtected = appendProtectedContent(ctx, selection, search, entry.summary);
        const blockId = allocateBlockId(ctx.state);
        const stored = wrapSummary(blockId, withProtected);
        const count = applyCompression(
            ctx.state,
            runId,
            entry.topic || args.topic,
            selection,
            resolveAnchorMessageId(start),
            messages[messages.length - 1]?.id ?? "",
            toolCallId,
            blockId,
            stored,
            [],
        );
        total += count;
        blockIds.push(blockId);
    }

    notifyCompression(ctx, notify, args.topic, blockIds, total);
    return total === 0
        ? "No messages were compressible (they may be protected)."
        : `Compressed ${total} messages into ${blockIds.length} ${blockIds.length === 1 ? "block" : "blocks"}.`;
}

function notifyCompression(ctx: CompressContext, notify: NotifyFn, topic: string, blockIds: number[], total: number): void {
    if (ctx.config.pruneNotification === "off" || !blockIds.length) return;
    if (ctx.config.pruneNotification === "minimal") {
        notify(`Compressed ${total} messages (${blockIds.map((b) => `b${b}`).join(", ")})`, "info");
        return;
    }
    const parts: string[] = [`Compressed ${total} messages into ${blockIds.length} block(s): ${topic}`];
    if (ctx.config.compress.showCompression) {
        for (const id of blockIds) {
            const block = ctx.state.prune.messages.blocksById.get(id);
            if (block) parts.push(restoreSummary(block.summary).slice(0, 500));
        }
    }
    notify(parts.join("\n"), "info");
}

export function sessionKeyFor(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile();
    if (file) {
        return file.split("/").pop()!.replace(/\.jsonl$/, "");
    }
    return ctx.sessionManager.getSessionId() ?? "inmemory";
}

export async function loadStateForSession(state: SessionState, sessionKey: string, logger: Logger): Promise<void> {
    state.sessionKey = sessionKey;
    const { loadSessionState } = await import("./persistence.ts");
    const persisted = await loadSessionState(sessionKey, logger);
    if (persisted) await applyPersistedState(state, persisted, logger);
}


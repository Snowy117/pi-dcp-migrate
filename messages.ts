import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PluginConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import {
    createPruneMessagesState,
    type CompressionBlock,
    type SessionState,
    type ToolMeta,
} from "./types.ts";
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "./patterns.ts";
import { countMessageTokens } from "./tokens.ts";

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

export function formatMessageRef(index: number): string {
    return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`;
}

export function parseMessageRef(ref: string): number | null {
    const match = ref.trim().toLowerCase().match(MESSAGE_REF_REGEX);
    if (!match) return null;
    const index = Number.parseInt(match[1]!, 10);
    if (index < 1 || index > MESSAGE_REF_MAX_INDEX) return null;
    return index;
}

export function parseBlockRef(ref: string): number | null {
    const match = ref.trim().toLowerCase().match(BLOCK_REF_REGEX);
    if (!match) return null;
    const id = Number.parseInt(match[1]!, 10);
    return Number.isInteger(id) ? id : null;
}

export type ParsedBoundaryId =
    | { kind: "message"; ref: string; index: number }
    | { kind: "compressed-block"; ref: string; blockId: number };

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
    const messageIndex = parseMessageRef(id);
    if (messageIndex !== null) return { kind: "message", ref: formatMessageRef(messageIndex), index: messageIndex };
    const blockId = parseBlockRef(id);
    if (blockId !== null) return { kind: "compressed-block", ref: `b${blockId}`, blockId };
    return null;
}

export function formatMessageIdTag(ref: string): string {
    return `\n(dcp-msg-id ${ref})`;
}

/** Correlate pi context messages with stable session entry IDs. */
export function collectMessageEntryIds(ctx: ExtensionContext): string[] {
    const entries = ctx.sessionManager.getBranch();
    const byId = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) byId.set(entry.id, entry);

    const leafId = ctx.sessionManager.getLeafId();
    let leaf: (typeof entries)[number] | undefined;
    if (leafId === null) return [];
    if (leafId) leaf = byId.get(leafId);
    if (!leaf) leaf = entries[entries.length - 1];
    if (!leaf) return [];

    const path: (typeof entries)[number][] = [];
    let current: (typeof entries)[number] | undefined = leaf;
    while (current) {
        path.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    path.reverse();

    let compaction: (typeof entries)[number] | undefined;
    for (const entry of path) {
        if (entry.type === "compaction") compaction = entry;
    }

    const ids: string[] = [];
    const push = (entry: (typeof entries)[number]) => {
        if (entry.type === "message") ids.push(entry.id);
        else if (entry.type === "custom_message") ids.push(entry.id);
        else if (entry.type === "branch_summary" && entry.summary) ids.push(entry.id);
    };

    if (compaction && compaction.type === "compaction") {
        ids.push(compaction.id);
        const compactionIdx = path.findIndex((e) => e.id === compaction!.id);
        let foundFirstKept = false;
        for (let i = 0; i < compactionIdx; i++) {
            const entry = path[i]!;
            if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
            if (foundFirstKept) push(entry);
        }
        for (let i = compactionIdx + 1; i < path.length; i++) push(path[i]!);
    } else {
        for (const entry of path) push(entry);
    }
    return ids;
}

export function isCompactionSummary(message: AgentMessage): boolean {
    return message.role === "compactionSummary";
}

/** Find the most recent compaction timestamp in the context (pi compactionSummary message). */
export function findLastCompactionTimestamp(messages: DcpMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isCompactionSummary(messages[i]!.message)) return messages[i]!.message.timestamp;
    }
    return 0;
}

function allocateNextMessageRef(state: SessionState): string {
    let candidate = Number.isInteger(state.messageIds.nextRef)
        ? Math.max(1, state.messageIds.nextRef)
        : 1;
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
        const ref = allocateNextMessageRef(state);
        state.messageIds.byRawId.set(entry.id, ref);
        state.messageIds.byRef.set(ref, entry.id);
        entry.ref = ref;
        assigned++;
    }
    return assigned;
}

export function getLastUserMessage(messages: DcpMessage[], startIndex?: number): DcpMessage | null {
    const start = startIndex ?? messages.length - 1;
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.message.role === "user" && !isIgnoredUserMessage(msg)) return msg;
    }
    return null;
}

export function isIgnoredUserMessage(entry: DcpMessage): boolean {
    if (entry.message.role !== "user") return false;
    const content = entry.message.content;
    if (typeof content === "string") return content.trim().length === 0;
    if (!Array.isArray(content) || content.length === 0) return true;
    return content.every((c) => c.type !== "text" || !c.text?.trim());
}

export function isProtectedUserMessage(config: PluginConfig, entry: DcpMessage): boolean {
    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages &&
        entry.message.role === "user" &&
        !isIgnoredUserMessage(entry)
    );
}

function messageHasCompress(entry: DcpMessage): boolean {
    if (entry.message.role !== "assistant") return false;
    return entry.message.content.some((c) => c.type === "toolCall" && c.name === "compress");
}

export function countTurns(state: SessionState, messages: DcpMessage[]): number {
    let count = 0;
    for (const entry of messages) {
        if (isMessageCompacted(state, entry)) continue;
        if (entry.message.role === "assistant") count++;
    }
    return count;
}

export function isMessageCompacted(state: SessionState, entry: DcpMessage): boolean {
    if (!entry.id) return false;
    if (isCompactionSummary(entry.message)) return true;
    const pruneEntry = state.prune.messages.byMessageId.get(entry.id);
    return !!pruneEntry && pruneEntry.activeBlockIds.length > 0;
}

export function buildToolIdList(state: SessionState, messages: DcpMessage[]): string[] {
    const ids: string[] = [];
    for (const entry of messages) {
        if (isMessageCompacted(state, entry)) continue;
        if (entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
            if (block.type === "toolCall") ids.push(block.id);
        }
    }
    state.toolIdList = ids;
    return ids;
}

export function buildToolMeta(
    state: SessionState,
    config: PluginConfig,
    messages: DcpMessage[],
): void {
    state.toolMeta.clear();
    const turnProtectionEnabled = config.turnProtection.enabled;
    const protectTurns = Math.max(1, config.turnProtection.turns);

    for (const entry of messages) {
        if (entry.message.role !== "assistant") continue;
        for (const block of entry.message.content) {
            if (block.type !== "toolCall") continue;
            const result = findToolResult(messages, block.id);
            const status: ToolMeta["status"] = result
                ? result.message.role === "toolResult" && result.message.isError
                    ? "error"
                    : "completed"
                : "running";
            const turn = state.currentTurn;
            let tokenCount = countMessageTokens({
                role: "toolResult",
                toolCallId: block.id,
                toolName: block.name,
                content: result && result.message.role === "toolResult" ? result.message.content : [],
                isError: status === "error",
                timestamp: 0,
            });
            tokenCount += countMessageTokens({
                role: "assistant",
                content: [{ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }],
                api: "" as any,
                provider: "" as any,
                model: "",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any,
                stopReason: "stop",
                timestamp: 0,
            });

            if (turnProtectionEnabled) {
                const turnAge = state.currentTurn - turn;
                if (turnAge < protectTurns) {
                    state.prune.tools.delete(block.id);
                }
            }

            state.toolMeta.set(block.id, {
                tool: block.name,
                arguments: block.arguments,
                status,
                turn,
                tokenCount,
                assistantEntryId: entry.id,
                resultEntryId: result?.id,
            });
        }
    }
}

function findToolResult(messages: DcpMessage[], toolCallId: string): DcpMessage | undefined {
    return messages.find(
        (m) => m.message.role === "toolResult" && m.message.toolCallId === toolCallId,
    );
}

function isToolPruned(state: SessionState, toolCallId: string): boolean {
    return state.prune.tools.has(toolCallId);
}

export function deduplicate(
    state: SessionState,
    config: PluginConfig,
    messages: DcpMessage[],
): void {
    if (state.manualMode && !config.manualMode.automaticStrategies) return;
    if (!config.strategies.deduplication.enabled) return;

    const unpruned = state.toolIdList.filter((id) => !isToolPruned(state, id));
    if (!unpruned.length) return;

    const protectedTools = config.strategies.deduplication.protectedTools;
    const signatureMap = new Map<string, string[]>();

    for (const id of unpruned) {
        const meta = state.toolMeta.get(id);
        if (!meta) continue;
        if (isToolNameProtected(meta.tool, protectedTools)) continue;
        const filePaths = getFilePathsFromParameters(meta.tool, meta.arguments);
        if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue;

        const signature = toolSignature(meta.tool, meta.arguments);
        const list = signatureMap.get(signature);
        if (list) list.push(id);
        else signatureMap.set(signature, [id]);
    }

    const newPruned: string[] = [];
    for (const ids of signatureMap.values()) {
        if (ids.length > 1) newPruned.push(...ids.slice(0, -1));
    }

    for (const id of newPruned) {
        const meta = state.toolMeta.get(id);
        state.prune.tools.set(id, meta?.tokenCount ?? 0);
    }
}

function toolSignature(tool: string, parameters?: any): string {
    if (!parameters) return tool;
    return `${tool}::${JSON.stringify(sortObjectKeys(normalizeParameters(parameters)))}`;
}

function normalizeParameters(params: any): any {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return params;
    const out: any = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) out[key] = value;
    }
    return out;
}

function sortObjectKeys(obj: any): any {
    if (typeof obj !== "object" || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);
    const out: any = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortObjectKeys(obj[key]);
    return out;
}

export function purgeErrors(
    state: SessionState,
    config: PluginConfig,
    messages: DcpMessage[],
): void {
    if (state.manualMode && !config.manualMode.automaticStrategies) return;
    if (!config.strategies.purgeErrors.enabled) return;

    const unpruned = state.toolIdList.filter((id) => !isToolPruned(state, id));
    if (!unpruned.length) return;

    const protectedTools = config.strategies.purgeErrors.protectedTools;
    const threshold = Math.max(1, config.strategies.purgeErrors.turns);

    for (const id of unpruned) {
        const meta = state.toolMeta.get(id);
        if (!meta || meta.status !== "error") continue;
        if (isToolNameProtected(meta.tool, protectedTools)) continue;
        const filePaths = getFilePathsFromParameters(meta.tool, meta.arguments);
        if (isFilePathProtected(filePaths, config.protectedFilePatterns)) continue;
        if (state.currentTurn - meta.turn >= threshold) {
            state.prune.tools.set(id, meta.tokenCount);
            state.stats.totalPruneTokens += meta.tokenCount;
        }
    }
}

export function syncCompressionBlocks(state: SessionState, logger: Logger, messages: DcpMessage[]): void {
    const messagesState = state.prune.messages;
    if (!messagesState.blocksById.size) return;

    const presentIds = new Set(messages.map((m) => m.id));
    const previousActive = new Set<number>(
        [...messagesState.blocksById.values()].filter((b) => b.active).map((b) => b.blockId),
    );

    messagesState.activeBlockIds.clear();
    messagesState.activeByAnchorMessageId.clear();
    const now = Date.now();
    const ordered = [...messagesState.blocksById.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.blockId - b.blockId,
    );

    for (const block of ordered) {
        const hasOrigin =
            typeof block.compressMessageId === "string" &&
            block.compressMessageId.length > 0 &&
            presentIds.has(block.compressMessageId);

        if (!hasOrigin) {
            if (block.active) {
                block.active = false;
                block.deactivatedAt = now;
                block.deactivatedByBlockId = undefined;
            }
            continue;
        }
        if (block.invalidated) {
            block.active = false;
            if (block.deactivatedAt === undefined) block.deactivatedAt = now;
            block.deactivatedByBlockId = undefined;
            continue;
        }
        if (block.deactivatedByUser) {
            block.active = false;
            if (block.deactivatedAt === undefined) block.deactivatedAt = now;
            block.deactivatedByBlockId = undefined;
            continue;
        }

        for (const consumedId of block.consumedBlockIds) {
            if (!messagesState.activeBlockIds.has(consumedId)) continue;
            const consumed = messagesState.blocksById.get(consumedId);
            if (consumed) {
                consumed.active = false;
                consumed.deactivatedAt = now;
                consumed.deactivatedByBlockId = block.blockId;
                const mapped = messagesState.activeByAnchorMessageId.get(consumed.anchorMessageId);
                if (mapped === consumed.blockId) messagesState.activeByAnchorMessageId.delete(consumed.anchorMessageId);
            }
            messagesState.activeBlockIds.delete(consumedId);
        }

        block.active = true;
        block.deactivatedAt = undefined;
        block.deactivatedByBlockId = undefined;
        messagesState.activeBlockIds.add(block.blockId);
        if (presentIds.has(block.anchorMessageId)) {
            messagesState.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId);
        }
    }

    for (const entry of messagesState.byMessageId.values()) {
        entry.activeBlockIds = entry.allBlockIds.filter((id) => messagesState.activeBlockIds.has(id));
    }

    invalidateSplitToolTransactions(state, messages, logger, now);

    let changed = false;
    for (const id of previousActive) if (!messagesState.activeBlockIds.has(id)) changed = true;
    for (const id of messagesState.activeBlockIds) if (!previousActive.has(id)) changed = true;
    if (changed) logger.debug("Synced compression block state", { active: messagesState.activeBlockIds.size });
}

function invalidateSplitToolTransactions(
    state: SessionState,
    messages: DcpMessage[],
    logger: Logger,
    now: number,
): void {
    const resultsByCallId = new Map<string, DcpMessage>();
    for (const entry of messages) {
        if (entry.message.role === "toolResult") resultsByCallId.set(entry.message.toolCallId, entry);
    }

    const invalidBlockIds = new Set<number>();
    for (const assistant of messages) {
        if (!assistant.id || assistant.message.role !== "assistant") continue;
        const assistantBlocks = state.prune.messages.byMessageId.get(assistant.id)?.activeBlockIds ?? [];
        const assistantCompacted = assistantBlocks.length > 0;
        for (const block of assistant.message.content) {
            if (block.type !== "toolCall") continue;
            const result = resultsByCallId.get(block.id);
            if (!result?.id) continue;
            const resultBlocks = state.prune.messages.byMessageId.get(result.id)?.activeBlockIds ?? [];
            const resultCompacted = resultBlocks.length > 0;
            if (assistantCompacted === resultCompacted) continue;
            for (const id of assistantBlocks) invalidBlockIds.add(id);
            for (const id of resultBlocks) invalidBlockIds.add(id);
        }
    }
    if (!invalidBlockIds.size) return;

    for (const blockId of invalidBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId);
        if (!block) continue;
        block.invalidated = true;
        block.active = false;
        block.deactivatedAt = now;
        block.deactivatedByBlockId = undefined;
        state.prune.messages.activeBlockIds.delete(blockId);
        if (state.prune.messages.activeByAnchorMessageId.get(block.anchorMessageId) === blockId) {
            state.prune.messages.activeByAnchorMessageId.delete(block.anchorMessageId);
        }
    }
    for (const entry of state.prune.messages.byMessageId.values()) {
        entry.activeBlockIds = entry.allBlockIds.filter((id) => state.prune.messages.activeBlockIds.has(id));
    }
    logger.warn("Disabled compression blocks that split tool transactions", { blockIds: [...invalidBlockIds] });
    void saveSessionStateQuiet(state, logger);
}

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]";
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]";

function applyToolPruning(state: SessionState, messages: DcpMessage[]): void {
    for (const entry of messages) {
        if (isMessageCompacted(state, entry)) continue;
        const message = entry.message;

        if (message.role === "assistant") {
            let mutated = false;
            for (const block of message.content) {
                if (block.type !== "toolCall") continue;
                if (!isToolPruned(state, block.id)) continue;
                const meta = state.toolMeta.get(block.id);
                if (meta?.status === "error") {
                    const args: Record<string, any> = {};
                    for (const [key, value] of Object.entries(block.arguments ?? {})) {
                        args[key] = typeof value === "string" ? PRUNED_TOOL_ERROR_INPUT_REPLACEMENT : value;
                    }
                    block.arguments = args;
                    mutated = true;
                }
            }
            if (mutated) entry.message = { ...message };
            continue;
        }

        if (message.role === "toolResult") {
            if (!isToolPruned(state, message.toolCallId)) continue;
            if (message.toolName === "edit" || message.toolName === "write") continue;
            entry.message = {
                ...message,
                content: [{ type: "text", text: PRUNED_TOOL_OUTPUT_REPLACEMENT }],
            };
        }
    }
}

function filterCompressedRanges(state: SessionState, logger: Logger, messages: DcpMessage[]): DcpMessage[] {
    const messagesState = state.prune.messages;
    if (!messagesState.byMessageId.size && !messagesState.activeByAnchorMessageId.size) return messages;

    const result: DcpMessage[] = [];
    for (const entry of messages) {
        const id = entry.id;
        const blockId = id ? messagesState.activeByAnchorMessageId.get(id) : undefined;
        const summary = blockId !== undefined ? messagesState.blocksById.get(blockId) : undefined;

        if (summary && summary.active && typeof summary.summary === "string" && summary.summary.length > 0) {
            result.push(makeSyntheticSummaryEntry(summary.summary, summary));
            logger.debug("Injected compress summary", { anchor: id, blockId });
        }

        if (id) {
            const pruneEntry = messagesState.byMessageId.get(id);
            if (pruneEntry && pruneEntry.activeBlockIds.length > 0) continue;
        }
        result.push(entry);
    }
    return result;
}

let syntheticCounter = 0;
function makeSyntheticSummaryEntry(summaryContent: string, block: CompressionBlock): DcpMessage {
    syntheticCounter++;
    const timestamp = block.createdAt || Date.now();
    const message: AgentMessage = {
        role: "user",
        content: summaryContent,
        timestamp,
    };
    return {
        id: `dcp-summary-${block.blockId}-${syntheticCounter}`,
        index: 0,
        message,
    };
}

export function pruneMessages(
    state: SessionState,
    logger: Logger,
    messages: DcpMessage[],
): DcpMessage[] {
    applyToolPruning(state, messages);
    return filterCompressedRanges(state, logger, messages);
}

/** Strip any leaked DCP tags the model may have echoed into its output. */
export function stripHallucinations(text: string): string {
    return text
        .replace(/<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi, "")
        .replace(/<\/?dcp[^>]*>/gi, "")
        .replace(/\(dcp-system-reminder\b[\s\S]*?\n\)/gi, "")
        .replace(/\(dcp-msg-id\s+[^)\r\n]+\)/gi, "")
        .replace(/\(dcp-compress-triggered-manually\)/gi, "")
        .trim();
}

export function resetOnCompaction(state: SessionState): void {
    state.toolMeta.clear();
    state.prune.tools = new Map();
    state.prune.messages = createPruneMessagesState();
    state.messageIds = { byRawId: new Map(), byRef: new Map(), nextRef: 1 };
    state.nudges = {
        contextLimitAnchors: new Set(),
        turnNudgeAnchors: new Set(),
        iterationNudgeAnchors: new Set(),
    };
}

export function getActiveSummaryTokenUsage(state: SessionState): number {
    let total = 0;
    for (const blockId of state.prune.messages.activeBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId);
        if (block && block.active) total += block.summaryTokens;
    }
    return total;
}

export function getCurrentTokenUsage(state: SessionState, messages: DcpMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const entry = messages[i]!;
        if (entry.message.role !== "assistant") continue;
        const usage = entry.message.usage;
        if (!usage || (usage.output ?? 0) <= 0) continue;
        if (state.lastCompaction > 0 && entry.message.timestamp < state.lastCompaction) return 0;
        return (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + (usage.reasoning || 0);
    }
    return 0;
}

export { messageHasCompress };


type NudgeRuntime = {
    system: string;
    contextLimitNudge: string;
    turnNudge: string;
    iterationNudge: string;
};

function findLastNonIgnored(messages: DcpMessage[]): { message: DcpMessage; index: number } | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (!isIgnoredUserMessage(messages[i]!)) return { message: messages[i]!, index: i };
    }
    return null;
}

function countMessagesAfter(messages: DcpMessage[], index: number): number {
    let count = 0;
    for (let i = index + 1; i < messages.length; i++) {
        if (!isIgnoredUserMessage(messages[i]!)) count++;
    }
    return count;
}

function resolveLimit(value: number | `${number}%` | undefined, modelContextLimit: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number") return value;
    if (!value.endsWith("%") || modelContextLimit === undefined) return undefined;
    const pct = parseFloat(value.slice(0, -1));
    if (isNaN(pct)) return undefined;
    return Math.round((Math.max(0, Math.min(100, pct)) / 100) * modelContextLimit);
}

function isContextOverLimits(state: SessionState, config: PluginConfig, providerId: string | undefined, modelId: string | undefined, messages: DcpMessage[]) {
    const summaryExtension = config.compress.summaryBuffer ? getActiveSummaryTokenUsage(state) : 0;
    const modelKey = providerId !== undefined && modelId !== undefined ? `${providerId}/${modelId}` : undefined;
    const maxOverride = modelKey ? config.compress.modelMaxLimits?.[modelKey] : undefined;
    const minOverride = modelKey ? config.compress.modelMinLimits?.[modelKey] : undefined;
    const resolvedMax = resolveLimit(maxOverride ?? config.compress.maxContextLimit, state.modelContextLimit);
    const resolvedMin = resolveLimit(minOverride ?? config.compress.minContextLimit, state.modelContextLimit);
    const maxLimit = resolvedMax === undefined ? undefined : resolvedMax + summaryExtension;
    const current = getCurrentTokenUsage(state, messages);
    return {
        overMaxLimit: maxLimit === undefined ? false : current > maxLimit,
        overMinLimit: resolvedMin === undefined ? true : current >= resolvedMin,
    };
}

function appendGuidanceToTag(nudge: string, guidance: string): string {
    if (!guidance.trim()) return nudge;
    const legacyCloseTag = "</dcp-system-reminder>";
    const legacyIdx = nudge.lastIndexOf(legacyCloseTag);
    if (legacyIdx !== -1) {
        return `${nudge.slice(0, legacyIdx).trimEnd()}\n\n${guidance}\n${nudge.slice(legacyIdx)}`;
    }

    const trimmed = nudge.trimEnd();
    if (!trimmed.startsWith("(dcp-system-reminder") || !trimmed.endsWith(")")) return nudge;
    const idx = trimmed.length - 1;
    return `${trimmed.slice(0, idx).trimEnd()}\n\n${guidance}\n)${nudge.slice(trimmed.length)}`;
}

function buildCompressedBlockGuidance(state: SessionState): string {
    const refs = [...state.prune.messages.activeBlockIds]
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => `b${id}`);
    return [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${refs.length} (${refs.join(", ") || "none"})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ].join("\n");
}

function assistantHasToolCall(entry: DcpMessage): boolean {
    return entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall");
}

function findLastToolResultForAssistant(messages: DcpMessage[], assistant: DcpMessage): DcpMessage | undefined {
    if (assistant.message.role !== "assistant") return undefined;
    const callIds = new Set(
        assistant.message.content.filter((block) => block.type === "toolCall").map((block) => block.id),
    );
    let lastResult: DcpMessage | undefined;
    for (const candidate of messages) {
        if (candidate.message.role === "toolResult" && callIds.has(candidate.message.toolCallId)) {
            lastResult = candidate;
        }
    }
    return lastResult;
}

function injectIntoMessage(entry: DcpMessage, text: string): void {
    if (!text.trim()) return;
    const message = entry.message;
    if (message.role === "user") {
        if (typeof message.content === "string") {
            message.content = `${message.content.replace(/\n*$/, "")}\n\n${text.trim()}`;
            return;
        }
        if (Array.isArray(message.content)) {
            for (let i = message.content.length - 1; i >= 0; i--) {
                const block = message.content[i]!;
                if (block.type === "text" && typeof block.text === "string") {
                    block.text = `${block.text.replace(/\n*$/, "")}\n\n${text.trim()}`;
                    return;
                }
            }
            message.content.push({ type: "text", text: text.trim() });
        }
        return;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
        // Some OpenAI-compatible serializers split mixed assistant content into
        // separate messages. Adding metadata text to a tool-call message can
        // therefore produce `assistant(tool_calls), assistant(text), tool`,
        // which violates the required tool transaction ordering.
        if (assistantHasToolCall(entry)) return;
        for (const block of message.content) {
            if (block.type === "text" && typeof block.text === "string") {
                block.text = `${block.text.replace(/\n*$/, "")}\n\n${text.trim()}`;
                return;
            }
        }
        message.content.push({ type: "text", text: text.trim() });
        return;
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
        message.content.push({ type: "text", text: text.trim() });
    }
}

export function injectCompressNudges(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: DcpMessage[],
    prompts: NudgeRuntime,
): void {
    const last = findLastNonIgnored(messages);
    const lastAssistant = [...messages].reverse().find((m) => m.message.role === "assistant");

    if (lastAssistant && messageHasCompress(lastAssistant)) {
        let changed = false;
        if (state.nudges.contextLimitAnchors.size) { state.nudges.contextLimitAnchors.clear(); changed = true; }
        if (state.nudges.turnNudgeAnchors.size) { state.nudges.turnNudgeAnchors.clear(); changed = true; }
        if (state.nudges.iterationNudgeAnchors.size) { state.nudges.iterationNudgeAnchors.clear(); changed = true; }
        if (changed) void saveSessionStateQuiet(state, logger);
        return;
    }

    const providerId = lastAssistant?.message.role === "assistant" ? lastAssistant.message.provider : undefined;
    const modelId = lastAssistant?.message.role === "assistant" ? lastAssistant.message.model : undefined;
    const { overMaxLimit, overMinLimit } = isContextOverLimits(state, config, providerId, modelId, messages);

    let anchorsChanged = false;

    if (!overMinLimit) {
        if (state.nudges.turnNudgeAnchors.size || state.nudges.iterationNudgeAnchors.size) {
            state.nudges.turnNudgeAnchors.clear();
            state.nudges.iterationNudgeAnchors.clear();
            anchorsChanged = true;
        }
    }

    const interval = Math.max(1, Math.floor(config.compress.nudgeFrequency || 1));
    const iterationThreshold = Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1));

    if (overMaxLimit && last) {
        if (addAnchor(state.nudges.contextLimitAnchors, last.message.id, last.index, messages, interval)) anchorsChanged = true;
    } else if (overMinLimit) {
        const isLastUser = last?.message.message.role === "user";
        if (isLastUser && lastAssistant) {
            const before = state.nudges.turnNudgeAnchors.size;
            state.nudges.turnNudgeAnchors.add(last.message.id);
            state.nudges.turnNudgeAnchors.add(lastAssistant.id ?? lastAssistant.message.timestamp.toString());
            if (state.nudges.turnNudgeAnchors.size !== before) anchorsChanged = true;
        }
        const lastUser = getLastUserMessage(messages);
        if (lastUser && last) {
            const lastUserIndex = messages.findIndex((m) => m.id === lastUser.id);
            if (lastUserIndex >= 0 && last.index > lastUserIndex && countMessagesAfter(messages, lastUserIndex) >= iterationThreshold) {
                if (addAnchor(state.nudges.iterationNudgeAnchors, last.message.id, last.index, messages, interval)) anchorsChanged = true;
            }
        }
    }

    applyAnchoredNudges(state, config, messages, prompts);

    if (anchorsChanged) void saveSessionStateQuiet(state, logger);
}

function addAnchor(set: Set<string>, id: string, index: number, messages: DcpMessage[], interval: number): boolean {
    if (!id || index < 0) return false;
    let latestIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.id && set.has(messages[i]!.id)) { latestIdx = i; break; }
    }
    if (latestIdx >= 0 && index - latestIdx < interval) return false;
    const before = set.size;
    set.add(id);
    return set.size !== before;
}

function applyAnchoredNudges(state: SessionState, config: PluginConfig, messages: DcpMessage[], prompts: NudgeRuntime): void {
    const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant";
    const turnAnchors = new Set<string>();
    for (const m of messages) {
        if (state.nudges.turnNudgeAnchors.has(m.id ?? "") && m.message.role === targetRole) turnAnchors.add(m.id ?? "");
    }
    const compressedGuidance = config.compress.mode === "message" ? "" : buildCompressedBlockGuidance(state);

    const injectSet = (anchors: Set<string>, base: string) => {
        if (!base.trim()) return;
        const text = appendGuidanceToTag(base, compressedGuidance);
        const targets = new Set<DcpMessage>();
        for (const m of messages) {
            if (!anchors.has(m.id ?? "")) continue;
            if (!assistantHasToolCall(m)) {
                targets.add(m);
                continue;
            }

            const lastResult = findLastToolResultForAssistant(messages, m);
            if (lastResult) targets.add(lastResult);
        }
        for (const target of targets) injectIntoMessage(target, text);
    };
    injectSet(state.nudges.contextLimitAnchors, prompts.contextLimitNudge);
    injectSet(turnAnchors, prompts.turnNudge);
    injectSet(state.nudges.iterationNudgeAnchors, prompts.iterationNudge);
}

export function injectMessageIdTags(state: SessionState, config: PluginConfig, messages: DcpMessage[]): void {
    for (const entry of messages) {
        if (isIgnoredUserMessage(entry)) continue;
        if (entry.message.role === "compactionSummary") continue;
        if (assistantHasToolCall(entry)) continue;
        const ref = entry.id ? state.messageIds.byRawId.get(entry.id) : undefined;
        if (!ref) continue;
        const isBlocked = isProtectedUserMessage(config, entry);
        const tag = formatMessageIdTag(isBlocked ? "BLOCKED" : ref);
        injectIntoMessage(entry, tag);
    }
}

async function saveSessionStateQuiet(state: SessionState, logger: Logger): Promise<void> {
    const { saveSessionState } = await import("./persistence.ts");
    await saveSessionState(state, logger);
}

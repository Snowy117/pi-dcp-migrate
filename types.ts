import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type CompressionMode = "range" | "message";

export interface CompressionBlock {
    blockId: number;
    runId: number;
    active: boolean;
    deactivatedByUser: boolean;
    invalidated?: boolean;
    compressedTokens: number;
    summaryTokens: number;
    durationMs: number;
    mode?: CompressionMode;
    topic: string;
    batchTopic?: string;
    startId: string;
    endId: string;
    anchorMessageId: string;
    compressMessageId: string;
    compressCallId?: string;
    includedBlockIds: number[];
    consumedBlockIds: number[];
    parentBlockIds: number[];
    directMessageIds: string[];
    directToolIds: string[];
    effectiveMessageIds: string[];
    effectiveToolIds: string[];
    createdAt: number;
    deactivatedAt?: number;
    deactivatedByBlockId?: number;
    summary: string;
}

export interface PrunedMessageEntry {
    tokenCount: number;
    allBlockIds: number[];
    activeBlockIds: number[];
}

export interface PruneMessagesState {
    byMessageId: Map<string, PrunedMessageEntry>;
    blocksById: Map<number, CompressionBlock>;
    activeBlockIds: Set<number>;
    activeByAnchorMessageId: Map<string, number>;
    nextBlockId: number;
    nextRunId: number;
}

export interface ToolMeta {
    tool: string;
    arguments: any;
    status: "completed" | "error" | "running";
    turn: number;
    tokenCount: number;
    assistantEntryId: string;
    resultEntryId?: string;
}

export interface MessageIdState {
    byRawId: Map<string, string>;
    byRef: Map<string, string>;
    nextRef: number;
}

export interface Nudges {
    contextLimitAnchors: Set<string>;
    turnNudgeAnchors: Set<string>;
    iterationNudgeAnchors: Set<string>;
}

export interface SessionStats {
    pruneTokenCounter: number;
    totalPruneTokens: number;
}

export interface SessionState {
    sessionKey: string | null;
    manualMode: false | "active" | "compress-pending";
    pendingManualTrigger: { sessionKey: string; prompt: string } | null;
    compressPermission: "ask" | "allow" | "deny" | undefined;
    prune: {
        tools: Map<string, number>;
        messages: PruneMessagesState;
    };
    nudges: Nudges;
    stats: SessionStats;
    toolMeta: Map<string, ToolMeta>;
    toolIdList: string[];
    messageIds: MessageIdState;
    lastCompaction: number;
    currentTurn: number;
    modelContextLimit: number | undefined;
    lastEntries: { id: string; message: AgentMessage }[];
}

export function createPruneMessagesState(): PruneMessagesState {
    return {
        byMessageId: new Map(),
        blocksById: new Map(),
        activeBlockIds: new Set(),
        activeByAnchorMessageId: new Map(),
        nextBlockId: 1,
        nextRunId: 1,
    };
}

export function createSessionState(): SessionState {
    return {
        sessionKey: null,
        manualMode: false,
        pendingManualTrigger: null,
        compressPermission: undefined,
        prune: {
            tools: new Map(),
            messages: createPruneMessagesState(),
        },
        nudges: {
            contextLimitAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        toolMeta: new Map(),
        toolIdList: [],
        messageIds: { byRawId: new Map(), byRef: new Map(), nextRef: 1 },
        lastCompaction: 0,
        currentTurn: 0,
        modelContextLimit: undefined,
        lastEntries: [],
    };
}

export function resetSessionState(state: SessionState): void {
    state.sessionKey = null;
    state.manualMode = false;
    state.pendingManualTrigger = null;
    state.compressPermission = undefined;
    state.prune = { tools: new Map(), messages: createPruneMessagesState() };
    state.nudges = {
        contextLimitAnchors: new Set(),
        turnNudgeAnchors: new Set(),
        iterationNudgeAnchors: new Set(),
    };
    state.stats = { pruneTokenCounter: 0, totalPruneTokens: 0 };
    state.toolMeta.clear();
    state.toolIdList = [];
    state.messageIds = { byRawId: new Map(), byRef: new Map(), nextRef: 1 };
    state.lastCompaction = 0;
    state.currentTurn = 0;
    state.lastEntries = [];
}

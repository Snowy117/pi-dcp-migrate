import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./logger.ts";
import {
    createPruneMessagesState,
    type CompressionBlock,
    type PrunedMessageEntry,
    type SessionState,
} from "./types.ts";

const STORAGE_DIR =
    process.env.XDG_DATA_HOME
        ? join(process.env.XDG_DATA_HOME, "pi", "dcp")
        : join(homedir(), ".local", "share", "pi", "dcp");

function ensureStorageDir(): void {
    if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });
}

function sessionFilePath(sessionKey: string): string {
    return join(STORAGE_DIR, `${sessionKey}.json`);
}

interface PersistedPruneMessages {
    byMessageId: Record<string, PrunedMessageEntry>;
    blocksById: Record<string, CompressionBlock>;
    activeBlockIds: number[];
    activeByAnchorMessageId: Record<string, number>;
    nextBlockId: number;
    nextRunId: number;
}

interface PersistedState {
    manualMode?: boolean;
    prune: {
        tools?: Record<string, number>;
        messages?: PersistedPruneMessages;
    };
    nudges: {
        contextLimitAnchors: string[];
        turnNudgeAnchors?: string[];
        iterationNudgeAnchors?: string[];
    };
    stats: { pruneTokenCounter: number; totalPruneTokens: number };
    lastUpdated: string;
}

function serializeMessages(state: SessionState): PersistedPruneMessages {
    const m = state.prune.messages;
    return {
        byMessageId: Object.fromEntries(m.byMessageId),
        blocksById: Object.fromEntries(m.blocksById),
        activeBlockIds: [...m.activeBlockIds],
        activeByAnchorMessageId: Object.fromEntries(m.activeByAnchorMessageId),
        nextBlockId: m.nextBlockId,
        nextRunId: m.nextRunId,
    };
}

export async function saveSessionState(state: SessionState, logger: Logger): Promise<void> {
    try {
        if (!state.sessionKey) return;
        ensureStorageDir();
        const payload: PersistedState = {
            manualMode: !!state.manualMode,
            prune: {
                tools: Object.fromEntries(state.prune.tools),
                messages: serializeMessages(state),
            },
            nudges: {
                contextLimitAnchors: [...state.nudges.contextLimitAnchors],
                turnNudgeAnchors: [...state.nudges.turnNudgeAnchors],
                iterationNudgeAnchors: [...state.nudges.iterationNudgeAnchors],
            },
            stats: state.stats,
            lastUpdated: new Date().toISOString(),
        };
        await writeFile(sessionFilePath(state.sessionKey), JSON.stringify(payload, null, 2), "utf-8");
    } catch (error: any) {
        logger.error("Failed to save session state", { error: error?.message });
    }
}

function asNumberArray(value: unknown): number[] {
    return Array.isArray(value)
        ? [...new Set(value.filter((v): v is number => Number.isInteger(v) && v > 0))]
        : [];
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? [...new Set(value.filter((v): v is string => typeof v === "string"))]
        : [];
}

function loadPruneMessages(
    persisted: PersistedPruneMessages | undefined,
): ReturnType<typeof createPruneMessagesState> {
    const state = createPruneMessagesState();
    if (!persisted || typeof persisted !== "object") return state;
    if (Number.isInteger(persisted.nextBlockId)) state.nextBlockId = Math.max(1, persisted.nextBlockId);
    if (Number.isInteger(persisted.nextRunId)) state.nextRunId = Math.max(1, persisted.nextRunId);

    if (persisted.byMessageId && typeof persisted.byMessageId === "object") {
        for (const [messageId, entry] of Object.entries(persisted.byMessageId)) {
            if (!entry || typeof entry !== "object") continue;
            state.byMessageId.set(messageId, {
                tokenCount: typeof entry.tokenCount === "number" ? entry.tokenCount : 0,
                allBlockIds: asNumberArray(entry.allBlockIds),
                activeBlockIds: asNumberArray(entry.activeBlockIds),
            });
        }
    }

    if (persisted.blocksById && typeof persisted.blocksById === "object") {
        for (const [blockIdStr, block] of Object.entries(persisted.blocksById)) {
            const blockId = Number.parseInt(blockIdStr, 10);
            if (!Number.isInteger(blockId) || blockId < 1 || !block || typeof block !== "object") continue;
            state.blocksById.set(blockId, {
                blockId,
                runId: Number.isInteger(block.runId) && block.runId > 0 ? block.runId : blockId,
                active: block.active === true,
                deactivatedByUser: block.deactivatedByUser === true,
                invalidated: block.invalidated === true,
                compressedTokens: typeof block.compressedTokens === "number" ? Math.max(0, block.compressedTokens) : 0,
                summaryTokens: typeof block.summaryTokens === "number" ? Math.max(0, block.summaryTokens) : 0,
                durationMs: typeof block.durationMs === "number" ? Math.max(0, block.durationMs) : 0,
                mode: block.mode === "range" || block.mode === "message" ? block.mode : undefined,
                topic: typeof block.topic === "string" ? block.topic : "",
                batchTopic: typeof block.batchTopic === "string" ? block.batchTopic : "",
                startId: typeof block.startId === "string" ? block.startId : "",
                endId: typeof block.endId === "string" ? block.endId : "",
                anchorMessageId: typeof block.anchorMessageId === "string" ? block.anchorMessageId : "",
                compressMessageId: typeof block.compressMessageId === "string" ? block.compressMessageId : "",
                compressCallId: typeof block.compressCallId === "string" ? block.compressCallId : undefined,
                includedBlockIds: asNumberArray(block.includedBlockIds),
                consumedBlockIds: asNumberArray(block.consumedBlockIds),
                parentBlockIds: asNumberArray(block.parentBlockIds),
                directMessageIds: asStringArray(block.directMessageIds),
                directToolIds: asStringArray(block.directToolIds),
                effectiveMessageIds: asStringArray(block.effectiveMessageIds),
                effectiveToolIds: asStringArray(block.effectiveToolIds),
                createdAt: typeof block.createdAt === "number" ? block.createdAt : 0,
                deactivatedAt: typeof block.deactivatedAt === "number" ? block.deactivatedAt : undefined,
                deactivatedByBlockId:
                    Number.isInteger(block.deactivatedByBlockId) ? block.deactivatedByBlockId : undefined,
                summary: typeof block.summary === "string" ? block.summary : "",
            });
        }
    }

    for (const blockId of asNumberArray(persisted.activeBlockIds)) {
        state.activeBlockIds.add(blockId);
    }
    if (persisted.activeByAnchorMessageId && typeof persisted.activeByAnchorMessageId === "object") {
        for (const [anchor, blockId] of Object.entries(persisted.activeByAnchorMessageId)) {
            if (Number.isInteger(blockId)) state.activeByAnchorMessageId.set(anchor, blockId);
        }
    }
    for (const [blockId, block] of state.blocksById) {
        if (block.active) {
            state.activeBlockIds.add(blockId);
            if (block.anchorMessageId) state.activeByAnchorMessageId.set(block.anchorMessageId, blockId);
        }
        if (blockId >= state.nextBlockId) state.nextBlockId = blockId + 1;
        if (block.runId >= state.nextRunId) state.nextRunId = block.runId + 1;
    }
    return state;
}

export async function loadSessionState(
    sessionKey: string,
    logger: Logger,
): Promise<PersistedState | null> {
    try {
        const file = sessionFilePath(sessionKey);
        if (!existsSync(file)) return null;
        const content = await readFile(file, "utf-8");
        const parsed = JSON.parse(content) as PersistedState;
        if (!parsed?.prune || !parsed.stats || !parsed.nudges) {
            logger.warn("Invalid DCP state file, ignoring", { sessionKey });
            return null;
        }
        return parsed;
    } catch (error: any) {
        logger.warn("Failed to load DCP state", { sessionKey, error: error?.message });
        return null;
    }
}

export async function applyPersistedState(
    state: SessionState,
    persisted: PersistedState,
    logger: Logger,
): Promise<void> {
    state.manualMode = persisted.manualMode ? "active" : false;
    const tools = persisted.prune.tools ?? {};
    state.prune.tools = new Map(
        Object.entries(tools).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
    state.prune.messages = loadPruneMessages(persisted.prune.messages);
    state.nudges = {
        contextLimitAnchors: new Set(asStringArray(persisted.nudges.contextLimitAnchors)),
        turnNudgeAnchors: new Set(asStringArray(persisted.nudges.turnNudgeAnchors)),
        iterationNudgeAnchors: new Set(asStringArray(persisted.nudges.iterationNudgeAnchors)),
    };
    state.stats = {
        pruneTokenCounter: persisted.stats.pruneTokenCounter || 0,
        totalPruneTokens: persisted.stats.totalPruneTokens || 0,
    };
    void logger;
}

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

export function sessionKeyFromSessionFile(sessionFile: string): string {
    return sessionFile.split(/[\\/]/).pop()!.replace(/\.jsonl$/, "");
}

async function readParentSessionFile(sessionFile: string): Promise<string | null> {
    try {
        if (!existsSync(sessionFile)) return null;
        const content = await readFile(sessionFile, "utf-8");
        const firstLine = content.slice(0, content.indexOf("\n") === -1 ? undefined : content.indexOf("\n"));
        if (!firstLine.trim()) return null;
        const header = JSON.parse(firstLine);
        if (header?.type !== "session") return null;
        return typeof header.parentSession === "string" && header.parentSession ? header.parentSession : null;
    } catch {
        return null;
    }
}

const MAX_ANCESTOR_DEPTH = 32;

/**
 * Walk the `parentSession` chain starting at `sessionFile` and return the first
 * ancestor that has persisted DCP state. Used so a forked/cloned session
 * inherits the parent's compression blocks.
 */
export async function loadAncestorSessionState(
    sessionFile: string,
    logger: Logger,
): Promise<{ sessionKey: string; persisted: PersistedState } | null> {
    let current: string | null = sessionFile;
    const seen = new Set<string>();
    for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth++) {
        if (seen.has(current)) break;
        seen.add(current);
        const key = sessionKeyFromSessionFile(current);
        const persisted = await loadSessionState(key, logger);
        if (persisted) return { sessionKey: key, persisted };
        current = await readParentSessionFile(current);
    }
    return null;
}

/**
 * Drop inherited state that references entries the current session does not have.
 * Fork keeps entry IDs, so surviving entries stay addressable; truncated ones must go.
 */
export function restrictStateToEntries(state: SessionState, presentEntryIds: Set<string>): void {
    const messages = state.prune.messages;

    for (const [messageId] of [...messages.byMessageId]) {
        if (!presentEntryIds.has(messageId)) messages.byMessageId.delete(messageId);
    }

    for (const [blockId, block] of [...messages.blocksById]) {
        const originPresent = !!block.compressMessageId && presentEntryIds.has(block.compressMessageId);
        const anchorPresent = !!block.anchorMessageId && presentEntryIds.has(block.anchorMessageId);
        if (originPresent && anchorPresent) continue;
        messages.blocksById.delete(blockId);
        messages.activeBlockIds.delete(blockId);
        if (messages.activeByAnchorMessageId.get(block.anchorMessageId) === blockId) {
            messages.activeByAnchorMessageId.delete(block.anchorMessageId);
        }
    }

    for (const [anchor, blockId] of [...messages.activeByAnchorMessageId]) {
        if (!messages.blocksById.has(blockId) || !presentEntryIds.has(anchor)) {
            messages.activeByAnchorMessageId.delete(anchor);
        }
    }

    for (const entry of messages.byMessageId.values()) {
        entry.allBlockIds = entry.allBlockIds.filter((id) => messages.blocksById.has(id));
        entry.activeBlockIds = entry.activeBlockIds.filter((id) => messages.activeBlockIds.has(id));
    }

    for (const [messageId, entry] of [...messages.byMessageId]) {
        if (!entry.allBlockIds.length) messages.byMessageId.delete(messageId);
    }
}

interface PersistedPruneMessages {
    byMessageId: Record<string, PrunedMessageEntry>;
    blocksById: Record<string, CompressionBlock>;
    activeBlockIds: number[];
    activeByAnchorMessageId: Record<string, number>;
    nextBlockId: number;
    nextRunId: number;
}

export interface PersistedState {
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

export interface SessionIdentity {
    sessionKey: string;
    sessionFile: string | null | undefined;
    presentEntryIds: () => Set<string>;
}

/**
 * Load state for the active session, falling back to the nearest ancestor session
 * (`parentSession` chain) when the session has none of its own. Inherited state is
 * restricted to entries the active session still carries, then saved under its own key.
 */
export async function loadOrInheritSessionState(
    state: SessionState,
    identity: SessionIdentity,
    logger: Logger,
): Promise<void> {
    state.sessionKey = identity.sessionKey;

    const own = await loadSessionState(identity.sessionKey, logger);
    if (own) {
        await applyPersistedState(state, own, logger);
        return;
    }

    if (!identity.sessionFile) return;
    const inherited = await loadAncestorSessionState(identity.sessionFile, logger);
    if (!inherited) return;

    await applyPersistedState(state, inherited.persisted, logger);
    state.sessionKey = identity.sessionKey;
    restrictStateToEntries(state, identity.presentEntryIds());

    logger.info("Inherited DCP state from ancestor session", {
        from: inherited.sessionKey,
        to: identity.sessionKey,
        blocks: state.prune.messages.blocksById.size,
        activeBlocks: state.prune.messages.activeBlockIds.size,
    });

    await saveSessionState(state, logger);
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

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataHome = mkdtempSync(join(tmpdir(), "dcp-data-"));
process.env.XDG_DATA_HOME = dataHome;

const { loadOrInheritSessionState, saveSessionState, sessionKeyFromSessionFile } = await import("./persistence.ts");
const { Logger } = await import("./logger.ts");
const { createSessionState } = await import("./types.ts");

const logger = new Logger(false);
const sessionDir = mkdtempSync(join(tmpdir(), "dcp-sessions-"));
const stateDir = join(dataHome, "pi", "dcp");

function writeSession(name: string, entryIds: string[], parentSession?: string): string {
    const file = join(sessionDir, `${name}.jsonl`);
    const lines: string[] = [
        JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: "/tmp", parentSession }),
    ];
    let parentId: string | null = null;
    for (const id of entryIds) {
        lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: "x" } }));
        parentId = id;
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    return file;
}

function makeBlock(blockId: number, anchorMessageId: string, compressMessageId: string, directMessageIds: string[]) {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 20,
        durationMs: 0,
        mode: "range" as const,
        topic: `Block ${blockId}`,
        batchTopic: `Block ${blockId}`,
        startId: "m0001",
        endId: "m0002",
        anchorMessageId,
        compressMessageId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds,
        directToolIds: [],
        effectiveMessageIds: directMessageIds,
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: `[Compressed conversation section]\nSummary ${blockId}`,
    };
}

// Given: a parent session with two compression blocks, one of them anchored past the fork point
const parentEntries = ["e0", "e1", "e2", "e3", "e4", "e5"];
const parentFile = writeSession("parent", parentEntries);
const parentKey = sessionKeyFromSessionFile(parentFile);

const parentState = createSessionState();
parentState.sessionKey = parentKey;
parentState.stats = { pruneTokenCounter: 111, totalPruneTokens: 222 };
parentState.prune.tools.set("tool-1", 50);
const kept = makeBlock(1, "e0", "e2", ["e0", "e1"]);
const dropped = makeBlock(2, "e4", "e5", ["e4"]);
parentState.prune.messages.blocksById.set(1, kept);
parentState.prune.messages.blocksById.set(2, dropped);
parentState.prune.messages.activeBlockIds.add(1);
parentState.prune.messages.activeBlockIds.add(2);
parentState.prune.messages.activeByAnchorMessageId.set("e0", 1);
parentState.prune.messages.activeByAnchorMessageId.set("e4", 2);
parentState.prune.messages.byMessageId.set("e0", { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] });
parentState.prune.messages.byMessageId.set("e1", { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] });
parentState.prune.messages.byMessageId.set("e4", { tokenCount: 10, allBlockIds: [2], activeBlockIds: [2] });
parentState.prune.messages.nextBlockId = 3;
parentState.prune.messages.nextRunId = 3;
await saveSessionState(parentState, logger);

if (!existsSync(join(stateDir, `${parentKey}.json`))) throw new Error("parent state was not persisted");

// When: a fork truncated at e3 loads its state
const forkEntries = ["e0", "e1", "e2", "e3"];
const forkFile = writeSession("fork", forkEntries, parentFile);
const forkKey = sessionKeyFromSessionFile(forkFile);

const forkState = createSessionState();
await loadOrInheritSessionState(
    forkState,
    { sessionKey: forkKey, sessionFile: forkFile, presentEntryIds: () => new Set(forkEntries) },
    logger,
);

// Then: blocks whose origin/anchor survived the fork are inherited, the rest are dropped
console.log("=== Fork inheritance ===");
console.log("sessionKey:", forkState.sessionKey);
console.log("blocks:", [...forkState.prune.messages.blocksById.keys()]);
console.log("activeBlocks:", [...forkState.prune.messages.activeBlockIds]);
console.log("anchors:", [...forkState.prune.messages.activeByAnchorMessageId]);
console.log("byMessageId:", [...forkState.prune.messages.byMessageId.keys()]);
console.log("stats:", forkState.stats);

if (forkState.sessionKey !== forkKey) throw new Error("fork state kept the ancestor session key");
if (!forkState.prune.messages.blocksById.has(1)) throw new Error("surviving block was not inherited");
if (forkState.prune.messages.blocksById.has(2)) throw new Error("block past the fork point was not dropped");
if (!forkState.prune.messages.activeBlockIds.has(1)) throw new Error("inherited block is not active");
if (forkState.prune.messages.activeBlockIds.has(2)) throw new Error("dropped block is still active");
if (forkState.prune.messages.activeByAnchorMessageId.get("e0") !== 1) throw new Error("anchor mapping lost");
if (forkState.prune.messages.activeByAnchorMessageId.has("e4")) throw new Error("stale anchor mapping survived");
if (forkState.prune.messages.byMessageId.has("e4")) throw new Error("pruned entry outside the fork survived");
if (forkState.prune.messages.byMessageId.get("e1")?.activeBlockIds.length !== 1) {
    throw new Error("inherited pruned entry lost its block reference");
}
if (forkState.prune.messages.blocksById.get(1)!.summary !== kept.summary) throw new Error("summary text lost");
if (forkState.stats.totalPruneTokens !== 222) throw new Error("stats were not inherited");
if (forkState.prune.tools.get("tool-1") !== 50) throw new Error("tool pruning was not inherited");
if (forkState.prune.messages.nextBlockId < 3) throw new Error("nextBlockId regressed");

// Then: the inherited state is persisted under the fork's own key, leaving the parent untouched
const forkStateFile = join(stateDir, `${forkKey}.json`);
if (!existsSync(forkStateFile)) throw new Error("inherited state was not saved under the fork key");
const savedFork = JSON.parse(readFileSync(forkStateFile, "utf-8"));
if (Object.keys(savedFork.prune.messages.blocksById).length !== 1) throw new Error("saved fork state has wrong block count");
const savedParent = JSON.parse(readFileSync(join(stateDir, `${parentKey}.json`), "utf-8"));
if (Object.keys(savedParent.prune.messages.blocksById).length !== 2) throw new Error("parent state was mutated");

// When: a grandchild forks from the fork, with no state of its own for either fork level
const grandFile = writeSession("grandchild", ["e0", "e1"], join(sessionDir, "missing.jsonl"));
const grandKey = sessionKeyFromSessionFile(grandFile);
const grandState = createSessionState();
await loadOrInheritSessionState(
    grandState,
    { sessionKey: grandKey, sessionFile: grandFile, presentEntryIds: () => new Set(["e0", "e1"]) },
    logger,
);
console.log("\n=== Broken ancestor chain ===");
console.log("blocks:", [...grandState.prune.messages.blocksById.keys()]);
if (grandState.prune.messages.blocksById.size !== 0) throw new Error("state leaked across a broken parent chain");
if (grandState.sessionKey !== grandKey) throw new Error("session key not set for a stateless session");

// When: a session already has its own state, the ancestor is ignored
const ownFile = writeSession("own", ["e0"], parentFile);
const ownKey = sessionKeyFromSessionFile(ownFile);
const seedState = createSessionState();
seedState.sessionKey = ownKey;
seedState.stats = { pruneTokenCounter: 1, totalPruneTokens: 7 };
await saveSessionState(seedState, logger);

const ownState = createSessionState();
await loadOrInheritSessionState(
    ownState,
    { sessionKey: ownKey, sessionFile: ownFile, presentEntryIds: () => new Set(["e0"]) },
    logger,
);
console.log("\n=== Own state wins ===");
console.log("stats:", ownState.stats, "blocks:", ownState.prune.messages.blocksById.size);
if (ownState.stats.totalPruneTokens !== 7) throw new Error("own state was overwritten by the ancestor");
if (ownState.prune.messages.blocksById.size !== 0) throw new Error("ancestor blocks leaked into a session with own state");

console.log("\nALL TESTS PASSED");

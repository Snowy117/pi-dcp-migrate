import type { PluginConfig } from "./config.ts";
import { getActiveSummaryTokenUsage, getCurrentTokenUsage } from "./compression-state.ts";
import { isIgnoredUserMessage, type DcpMessage } from "./conversation.ts";
import { injectIntoMessage, messageHasCompress } from "./context-render.ts";
import type { Logger } from "./logger.ts";
import { assistantHasToolCall, findLastToolResultForAssistant } from "./tool-transactions.ts";
import type { SessionState } from "./types.ts";

export interface NudgeRuntime {
    system: string;
    contextLimitNudge: string;
    turnNudge: string;
    iterationNudge: string;
}

export function getLastUserMessage(messages: DcpMessage[], startIndex = messages.length - 1): DcpMessage | null {
    for (let index = startIndex; index >= 0; index--) {
        const entry = messages[index]!;
        if (entry.message.role === "user" && !isIgnoredUserMessage(entry)) return entry;
    }
    return null;
}

export function injectCompressNudges(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: DcpMessage[],
    prompts: NudgeRuntime,
): void {
    const last = findLastNonIgnored(messages);
    const lastAssistant = [...messages].reverse().find((entry) => entry.message.role === "assistant");
    if (lastAssistant && messageHasCompress(lastAssistant)) {
        if (clearAnchors(state)) void saveQuietly(state, logger);
        return;
    }

    const provider = lastAssistant?.message.role === "assistant" ? lastAssistant.message.provider : undefined;
    const model = lastAssistant?.message.role === "assistant" ? lastAssistant.message.model : undefined;
    const limits = contextLimits(state, config, provider, model, messages);
    let changed = false;
    if (!limits.overMin && (state.nudges.turnNudgeAnchors.size || state.nudges.iterationNudgeAnchors.size)) {
        state.nudges.turnNudgeAnchors.clear();
        state.nudges.iterationNudgeAnchors.clear();
        changed = true;
    }

    const interval = Math.max(1, Math.floor(config.compress.nudgeFrequency || 1));
    if (limits.overMax && last) {
        changed = addAnchor(state.nudges.contextLimitAnchors, last.entry.id, last.index, messages, interval) || changed;
    } else if (limits.overMin) {
        if (last?.entry.message.role === "user" && lastAssistant) {
            const before = state.nudges.turnNudgeAnchors.size;
            state.nudges.turnNudgeAnchors.add(last.entry.id);
            state.nudges.turnNudgeAnchors.add(lastAssistant.id || String(lastAssistant.message.timestamp));
            changed = state.nudges.turnNudgeAnchors.size !== before || changed;
        }
        const lastUser = getLastUserMessage(messages);
        const userIndex = lastUser ? messages.findIndex((entry) => entry.id === lastUser.id) : -1;
        if (lastUser && last && userIndex >= 0 && last.index > userIndex &&
            countMessagesAfter(messages, userIndex) >= Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))) {
            changed = addAnchor(state.nudges.iterationNudgeAnchors, last.entry.id, last.index, messages, interval) || changed;
        }
    }
    applyAnchoredNudges(state, config, messages, prompts);
    if (changed) void saveQuietly(state, logger);
}

function contextLimits(state: SessionState, config: PluginConfig, provider: string | undefined, model: string | undefined, messages: DcpMessage[]) {
    const modelKey = provider && model ? `${provider}/${model}` : undefined;
    const max = resolveLimit((modelKey ? config.compress.modelMaxLimits?.[modelKey] : undefined) ?? config.compress.maxContextLimit, state.modelContextLimit);
    const min = resolveLimit((modelKey ? config.compress.modelMinLimits?.[modelKey] : undefined) ?? config.compress.minContextLimit, state.modelContextLimit);
    const summary = config.compress.summaryBuffer ? getActiveSummaryTokenUsage(state) : 0;
    const current = getCurrentTokenUsage(state, messages);
    return { overMax: max === undefined ? false : current > max + summary, overMin: min === undefined ? true : current >= min };
}

function resolveLimit(value: number | `${number}%` | undefined, contextLimit: number | undefined): number | undefined {
    if (typeof value === "number") return value;
    if (!value?.endsWith("%") || contextLimit === undefined) return undefined;
    const percent = Number.parseFloat(value.slice(0, -1));
    return Number.isNaN(percent) ? undefined : Math.round(Math.max(0, Math.min(100, percent)) / 100 * contextLimit);
}

function findLastNonIgnored(messages: DcpMessage[]): { entry: DcpMessage; index: number } | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (!isIgnoredUserMessage(messages[index]!)) return { entry: messages[index]!, index };
    }
    return null;
}

function countMessagesAfter(messages: DcpMessage[], index: number): number {
    return messages.slice(index + 1).filter((entry) => !isIgnoredUserMessage(entry)).length;
}

function addAnchor(anchors: Set<string>, id: string, index: number, messages: DcpMessage[], interval: number): boolean {
    if (!id || index < 0) return false;
    let latest = -1;
    for (let candidate = messages.length - 1; candidate >= 0; candidate--) {
        if (messages[candidate]!.id && anchors.has(messages[candidate]!.id)) { latest = candidate; break; }
    }
    if (latest >= 0 && index - latest < interval) return false;
    const before = anchors.size;
    anchors.add(id);
    return anchors.size !== before;
}

function applyAnchoredNudges(state: SessionState, config: PluginConfig, messages: DcpMessage[], prompts: NudgeRuntime): void {
    const role = config.compress.nudgeForce === "strong" ? "user" : "assistant";
    const turnAnchors = new Set(messages.filter((entry) => state.nudges.turnNudgeAnchors.has(entry.id) && entry.message.role === role).map((entry) => entry.id));
    const guidance = config.compress.mode === "message" ? "" : blockGuidance(state);
    injectAnchors(messages, state.nudges.contextLimitAnchors, appendGuidance(prompts.contextLimitNudge, guidance));
    injectAnchors(messages, turnAnchors, appendGuidance(prompts.turnNudge, guidance));
    injectAnchors(messages, state.nudges.iterationNudgeAnchors, appendGuidance(prompts.iterationNudge, guidance));
}

function injectAnchors(messages: DcpMessage[], anchors: Set<string>, text: string): void {
    if (!text.trim()) return;
    const targets = new Set<DcpMessage>();
    for (const entry of messages) {
        if (!anchors.has(entry.id)) continue;
        const target = assistantHasToolCall(entry) ? findLastToolResultForAssistant(messages, entry) : entry;
        if (target) targets.add(target);
    }
    for (const target of targets) injectIntoMessage(target, text);
}

function blockGuidance(state: SessionState): string {
    const refs = [...state.prune.messages.activeBlockIds].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b).map((id) => `b${id}`);
    return ["Compressed block context:", `- Active compressed blocks in this session: ${refs.length} (${refs.join(", ") || "none"})`, "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`."].join("\n");
}

function appendGuidance(nudge: string, guidance: string): string {
    if (!guidance.trim()) return nudge;
    const close = "</dcp-system-reminder>";
    const legacy = nudge.lastIndexOf(close);
    if (legacy !== -1) return `${nudge.slice(0, legacy).trimEnd()}\n\n${guidance}\n${nudge.slice(legacy)}`;
    const trimmed = nudge.trimEnd();
    if (!trimmed.startsWith("(dcp-system-reminder") || !trimmed.endsWith(")")) return nudge;
    return `${trimmed.slice(0, -1).trimEnd()}\n\n${guidance}\n)${nudge.slice(trimmed.length)}`;
}

function clearAnchors(state: SessionState): boolean {
    const changed = state.nudges.contextLimitAnchors.size > 0 || state.nudges.turnNudgeAnchors.size > 0 || state.nudges.iterationNudgeAnchors.size > 0;
    state.nudges.contextLimitAnchors.clear();
    state.nudges.turnNudgeAnchors.clear();
    state.nudges.iterationNudgeAnchors.clear();
    return changed;
}

async function saveQuietly(state: SessionState, logger: Logger): Promise<void> {
    const { saveSessionState } = await import("./persistence.ts");
    await saveSessionState(state, logger);
}

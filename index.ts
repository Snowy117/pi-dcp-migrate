import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getConfig, type PluginConfig } from "./config.ts";
import { Logger } from "./logger.ts";
import { createSessionState, resetSessionState, type SessionState } from "./types.ts";
import { PromptStore, buildProtectedToolsExtension, renderSystemPrompt } from "./prompts.ts";
import {
    assignMessageRefs,
    buildToolIdList,
    buildToolMeta,
    collectMessageEntryIds,
    countTurns,
    deduplicate,
    type DcpMessage,
    findLastCompactionTimestamp,
    injectCompressNudges,
    injectMessageIdTags,
    isIgnoredUserMessage,
    messageHasCompress,
    pruneMessages,
    purgeErrors,
    resetOnCompaction,
    stripHallucinations,
    syncCompressionBlocks,
} from "./messages.ts";
import { loadStateForSession, registerCompressTool, sessionKeyFor } from "./compress.ts";
import { registerCommands } from "./commands.ts";
import { saveSessionState } from "./persistence.ts";

export { getConfig } from "./config.ts";

interface DcpRuntime {
    config: PluginConfig;
    logger: Logger;
    state: SessionState;
    prompts: PromptStore;
}

export default function (pi: ExtensionAPI): void {
    const cwd = process.cwd();
    const config = getConfig(cwd);
    const logger = new Logger(config.debug);
    const state = createSessionState();
    const prompts = new PromptStore(logger, config.experimental.customPrompts);

    if (!config.enabled) return;

    const runtime: DcpRuntime = { config, logger, state, prompts };
    let lastInjectionSignature = "";

    registerCompressTool({
        pi,
        state,
        config,
        logger,
        prompts: () => prompts.getRuntimePrompts(),
    });

    registerCommands({
        pi,
        state,
        config,
        logger,
        getSessionKey: () => state.sessionKey ?? "inmemory",
        onManualCompress: (focus) => triggerManualCompress(runtime, pi, focus),
    });

    pi.on("context", (event, ctx) => {
        return processContext(runtime, event.messages, ctx);
    });

    pi.on("before_agent_start", (event, ctx) => {
        return processBeforeAgentStart(runtime, event.systemPrompt, ctx);
    });

    pi.on("message_end", async (event) => {
        if (event.message.role !== "assistant") return;
        const content = event.message.content;
        if (!Array.isArray(content)) return;
        let changed = false;
        const newContent = content.map((block) => {
            if (block.type === "text" && typeof block.text === "string") {
                const stripped = stripHallucinations(block.text);
                if (stripped !== block.text) {
                    changed = true;
                    return { ...block, text: stripped };
                }
            }
            return block;
        });
        if (changed) return { message: { ...event.message, content: newContent } };
    });

    pi.on("session_start", async (_event, ctx) => {
        const key = sessionKeyFor(ctx);
        if (state.sessionKey !== key) {
            resetSessionState(state);
            state.sessionKey = key;
            state.manualMode = config.manualMode.enabled ? "active" : false;
            await loadStateForSession(state, ctx, logger);
            if (config.manualMode.enabled && !state.manualMode) state.manualMode = "active";
        }
        if (ctx.model?.contextWindow) state.modelContextLimit = ctx.model.contextWindow;
    });

    pi.on("model_select", (event) => {
        state.modelContextLimit = event.model.contextWindow;
    });

    pi.on("session_compact", () => {
        resetOnCompaction(state);
        state.lastCompaction = Date.now();
        logger.info("Compaction detected via session_compact event; reset DCP state");
    });

    pi.on("session_tree", () => {
        logger.debug("Tree navigation; DCP state will reconcile on next context event");
    });

    pi.on("session_shutdown", () => {
        if (state.sessionKey) {
            saveSessionState(state, logger).catch(() => {});
        }
    });

}

function triggerManualCompress(runtime: DcpRuntime, pi: ExtensionAPI, focus: string): void {
    const { state, config } = runtime;
    if (config.compress.permission === "deny") {
        pi.sendUserMessage("[DCP] Compress tool is disabled (compress.permission=deny). Manual compression unavailable.");
        return;
    }
    state.manualMode = "compress-pending";
    const body = focus
        ? `[Manual compression requested: ${focus}]\n(dcp-compress-triggered-manually)`
        : "[Manual compression requested]\n(dcp-compress-triggered-manually)";
    pi.sendUserMessage(body);
}

function processContext(
    runtime: DcpRuntime,
    rawMessages: AgentMessage[],
    ctx: ExtensionContext,
): { messages: AgentMessage[] } | void {
    const { state, config, logger } = runtime;
    if (!rawMessages.length) return;

    const entryIds = collectMessageEntryIds(ctx);
    const dcp: DcpMessage[] = [];
    for (let i = 0; i < rawMessages.length; i++) {
        dcp.push({ id: entryIds[i] ?? `ctx-${i}`, index: i, message: rawMessages[i]! });
    }

    const sessionKey = sessionKeyFor(ctx);
    if (state.sessionKey !== sessionKey) {
        resetSessionState(state);
        state.sessionKey = sessionKey;
        state.manualMode = config.manualMode.enabled ? "active" : false;
    }

    const lastCompaction = findLastCompactionTimestamp(dcp);
    if (lastCompaction > state.lastCompaction) {
        state.lastCompaction = lastCompaction;
        resetOnCompaction(state);
        logger.info("Detected compaction in context; reset stale state", { timestamp: lastCompaction });
    }

    state.currentTurn = countTurns(state, dcp);

    assignMessageRefs(state, dcp);
    syncCompressionBlocks(state, logger, dcp);
    buildToolIdList(state, dcp);
    buildToolMeta(state, config, dcp);
    deduplicate(state, config, dcp);
    purgeErrors(state, config, dcp);

    const pruned = pruneMessages(state, logger, dcp);

    if (effectivePermission(runtime) !== "deny" && !state.manualMode) {
        injectCompressNudges(state, config, logger, pruned, prompts_of(runtime));
    }
    if (effectivePermission(runtime) !== "deny") {
        injectMessageIdTags(state, config, pruned);
    }

    applyManualTrigger(runtime, pruned);

    const result = pruned.map((m) => m.message);
    return { messages: result };
}

function processBeforeAgentStart(
    runtime: DcpRuntime,
    systemPrompt: string,
    _ctx: ExtensionContext,
): { systemPrompt: string } | void {
    const { state, config, prompts } = runtime;
    if (effectivePermission(runtime) === "deny") return;

    if (isInternalAgent(systemPrompt)) return;

    prompts.reload();
    const runtimePrompts = prompts.getRuntimePrompts();
    const extension = renderSystemPrompt(
        runtimePrompts,
        buildProtectedToolsExtension(config.compress.protectedTools),
        !!state.manualMode,
    );

    if (!extension) return;
    return { systemPrompt: systemPrompt + "\n\n" + extension };
}

const INTERNAL_AGENT_SIGNATURES = [
    "you are a context summarization assistant",
];

function isInternalAgent(systemPrompt: string): boolean {
    const lower = systemPrompt.toLowerCase();
    return INTERNAL_AGENT_SIGNATURES.some((sig) => lower.includes(sig.toLowerCase()));
}

function effectivePermission(runtime: DcpRuntime): "ask" | "allow" | "deny" {
    return runtime.state.compressPermission ?? runtime.config.compress.permission;
}

function prompts_of(runtime: DcpRuntime) {
    return runtime.prompts.getRuntimePrompts();
}

function applyManualTrigger(runtime: DcpRuntime, messages: DcpMessage[]): void {
    const { state, config } = runtime;
    if (state.manualMode !== "compress-pending") return;
    if (config.compress.permission === "deny") return;

    const lastAssistant = [...messages].reverse().find((m) => m.message.role === "assistant");
    if (lastAssistant && messageHasCompress(lastAssistant)) {
        state.manualMode = "active";
        return;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.message.role !== "user" || isIgnoredUserMessage(msg)) continue;
        appendToUser(msg.message, "\n\n(dcp-compress-triggered-manually)");
        break;
    }
}

function appendToUser(message: AgentMessage, injection: string): void {
    if (message.role !== "user") return;
    if (typeof message.content === "string") {
        if (!message.content.includes(injection)) message.content = `${message.content.replace(/\n*$/, "")}\n\n${injection.trim()}`;
        return;
    }
    if (!Array.isArray(message.content)) return;
    for (let i = message.content.length - 1; i >= 0; i--) {
        const block = message.content[i]!;
        if (block.type === "text" && typeof block.text === "string") {
            if (!block.text.includes(injection)) {
                block.text = `${block.text.replace(/\n*$/, "")}\n\n${injection.trim()}`;
            }
            return;
        }
    }
    message.content.push({ type: "text", text: injection.trim() });
}


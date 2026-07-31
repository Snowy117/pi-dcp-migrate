import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { getConfig, type PluginConfig } from "./config.ts";
import { registerCompressTool } from "./compress.ts";
import { resetOnCompaction } from "./compression-state.ts";
import { injectCompressNudges } from "./context-nudges.ts";
import {
    injectMessageIdTags,
    messageHasCompress,
    pruneMessages,
    stripHallucinations,
} from "./context-render.ts";
import { isIgnoredUserMessage, type DcpMessage } from "./conversation.ts";
import { Logger } from "./logger.ts";
import { saveSessionState } from "./persistence.ts";
import { buildProtectedToolsExtension, PromptStore, renderSystemPrompt } from "./prompts.ts";
import {
    buildCanonicalConversation,
    conversationFromContext,
    loadStateForSession,
    reconcileConversation,
    sessionKeyFor,
} from "./session-runtime.ts";
import { createSessionState, resetSessionState, type SessionState } from "./types.ts";

interface DcpRuntime {
    config: PluginConfig;
    logger: Logger;
    state: SessionState;
    prompts: PromptStore;
}

export class DcpController {
    private readonly runtime: DcpRuntime;

    constructor(private readonly pi: ExtensionAPI, cwd = process.cwd()) {
        const config = getConfig(cwd);
        const logger = new Logger(config.debug);
        this.runtime = {
            config,
            logger,
            state: createSessionState(),
            prompts: new PromptStore(logger, config.experimental.customPrompts),
        };
    }

    install(): void {
        const { config, logger, state, prompts } = this.runtime;
        if (!config.enabled) return;
        registerCompressTool({ pi: this.pi, state, config, logger, prompts: () => prompts.getRuntimePrompts() });
        registerCommands({
            pi: this.pi,
            state,
            config,
            logger,
            getSessionKey: () => state.sessionKey ?? "inmemory",
            onManualCompress: (focus) => this.triggerManualCompress(focus),
        });
        this.pi.on("context", (event, ctx) => this.processContext(event.messages, ctx));
        this.pi.on("before_agent_start", (event) => this.processBeforeAgentStart(event.systemPrompt));
        this.pi.on("message_end", (event) => this.stripAssistantMetadata(event.message));
        this.pi.on("session_start", async (_event, ctx) => this.startSession(ctx));
        this.pi.on("model_select", (event) => { state.modelContextLimit = event.model.contextWindow; });
        this.pi.on("session_compact", () => this.handleCompaction());
        this.pi.on("session_tree", () => logger.debug("Tree navigation; DCP state will reconcile on next context event"));
        this.pi.on("session_shutdown", () => {
            if (state.sessionKey) saveSessionState(state, logger).catch(() => {});
        });
    }

    private triggerManualCompress(focus: string): void {
        const { state, config } = this.runtime;
        if (config.compress.permission === "deny") {
            this.pi.sendUserMessage("[DCP] Compress tool is disabled (compress.permission=deny). Manual compression unavailable.");
            return;
        }
        state.manualMode = "compress-pending";
        const body = focus
            ? `[Manual compression requested: ${focus}]\n(dcp-compress-triggered-manually)`
            : "[Manual compression requested]\n(dcp-compress-triggered-manually)";
        this.pi.sendUserMessage(body);
    }

    private async processContext(
        rawMessages: AgentMessage[],
        ctx: ExtensionContext,
    ): Promise<{ messages: AgentMessage[] } | void> {
        if (!rawMessages.length) return;
        const { state, config, logger } = this.runtime;
        const canonical = await buildCanonicalConversation(ctx);
        const messages = await conversationFromContext(rawMessages, ctx, canonical);
        const key = sessionKeyFor(ctx);
        if (state.sessionKey !== key) {
            resetSessionState(state);
            state.sessionKey = key;
            state.manualMode = config.manualMode.enabled ? "active" : false;
        }
        reconcileConversation(state, config, logger, canonical);
        const rendered = pruneMessages(state, logger, messages);
        if (this.permission() !== "deny" && !state.manualMode) {
            injectCompressNudges(state, config, logger, rendered, this.runtime.prompts.getRuntimePrompts());
        }
        if (this.permission() !== "deny") injectMessageIdTags(state, config, rendered);
        this.applyManualTrigger(rendered);
        return { messages: rendered.map((entry) => entry.message) };
    }

    private processBeforeAgentStart(systemPrompt: string): { systemPrompt: string } | void {
        if (this.permission() === "deny" || isInternalAgent(systemPrompt)) return;
        const { state, config, prompts } = this.runtime;
        prompts.reload();
        const extension = renderSystemPrompt(
            prompts.getRuntimePrompts(),
            buildProtectedToolsExtension(config.compress.protectedTools),
            !!state.manualMode,
        );
        return extension ? { systemPrompt: `${systemPrompt}\n\n${extension}` } : undefined;
    }

    private stripAssistantMetadata(message: AgentMessage): { message: AgentMessage } | void {
        if (message.role !== "assistant" || !Array.isArray(message.content)) return;
        let changed = false;
        const content = message.content.map((block) => {
            if (block.type !== "text" || typeof block.text !== "string") return block;
            const text = stripHallucinations(block.text);
            if (text === block.text) return block;
            changed = true;
            return { ...block, text };
        });
        return changed ? { message: { ...message, content } } : undefined;
    }

    private async startSession(ctx: ExtensionContext): Promise<void> {
        const { state, config, logger } = this.runtime;
        const key = sessionKeyFor(ctx);
        if (state.sessionKey !== key) {
            resetSessionState(state);
            state.sessionKey = key;
            state.manualMode = config.manualMode.enabled ? "active" : false;
            await loadStateForSession(state, ctx, logger);
            if (config.manualMode.enabled && !state.manualMode) state.manualMode = "active";
        }
        if (ctx.model?.contextWindow) state.modelContextLimit = ctx.model.contextWindow;
    }

    private handleCompaction(): void {
        resetOnCompaction(this.runtime.state);
        this.runtime.state.lastCompaction = Date.now();
        this.runtime.logger.info("Compaction detected via session_compact event; reset DCP state");
    }

    private permission(): "ask" | "allow" | "deny" {
        return this.runtime.state.compressPermission ?? this.runtime.config.compress.permission;
    }

    private applyManualTrigger(messages: DcpMessage[]): void {
        const { state, config } = this.runtime;
        if (state.manualMode !== "compress-pending" || config.compress.permission === "deny") return;
        const assistant = [...messages].reverse().find((entry) => entry.message.role === "assistant");
        if (assistant && messageHasCompress(assistant)) {
            state.manualMode = "active";
            return;
        }
        for (let index = messages.length - 1; index >= 0; index--) {
            const entry = messages[index]!;
            if (entry.message.role !== "user" || isIgnoredUserMessage(entry)) continue;
            appendToUser(entry.message, "(dcp-compress-triggered-manually)");
            break;
        }
    }
}

const INTERNAL_AGENT_SIGNATURES = ["you are a context summarization assistant"];

function isInternalAgent(systemPrompt: string): boolean {
    const lower = systemPrompt.toLowerCase();
    return INTERNAL_AGENT_SIGNATURES.some((signature) => lower.includes(signature));
}

function appendToUser(message: AgentMessage, injection: string): void {
    if (message.role !== "user") return;
    if (typeof message.content === "string") {
        if (!message.content.includes(injection)) message.content = `${message.content.replace(/\n*$/, "")}\n\n${injection}`;
        return;
    }
    if (!Array.isArray(message.content)) return;
    const text = [...message.content].reverse().find((block) => block.type === "text" && typeof block.text === "string");
    if (text?.type === "text") {
        if (!text.text.includes(injection)) text.text = `${text.text.replace(/\n*$/, "")}\n\n${injection}`;
    } else {
        message.content.push({ type: "text", text: injection });
    }
}


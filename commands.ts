import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PluginConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { SessionState } from "./types.ts";
import { saveSessionState } from "./persistence.ts";
import { getActiveSummaryTokenUsage } from "./messages.ts";

export interface CommandContext {
    pi: ExtensionAPI;
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
    getSessionKey: () => string;
    onManualCompress: (focus: string) => void;
}

export function registerCommands(ctx: CommandContext): void {
    if (!ctx.config.commands.enabled) return;

    ctx.pi.registerCommand("dcp", {
        description: "Dynamic Context Pruning: stats, context, and manual controls",
        handler: async (args, execCtx) => {
            const parts = (args || "").trim().split(/\s+/).filter(Boolean);
            const sub = parts[0]?.toLowerCase() ?? "";
            switch (sub) {
                case "":
                case "help": {
                    const lines = [
                        "DCP commands:",
                        "  /dcp stats     - show pruning statistics",
                        "  /dcp context   - show context usage",
                        "  /dcp manual on|off - toggle manual mode",
                        "  /dcp sweep     - run dedup + purge-errors now",
                        "  /dcp compress [focus] - trigger one manual compression",
                    ];
                    notifyLines(execCtx, lines);
                    break;
                }
                case "stats": {
                    const total = ctx.state.stats.totalPruneTokens;
                    const blocks = ctx.state.prune.messages.activeBlockIds.size;
                    const summaryTokens = getActiveSummaryTokenUsage(ctx.state);
                    notifyLines(execCtx, [
                        `DCP stats:`,
                        `  total tokens pruned (all time): ${total}`,
                        `  active compressed blocks: ${blocks}`,
                        `  active summary tokens: ${summaryTokens}`,
                    ]);
                    break;
                }
                case "context": {
                    const usage = execCtx.getContextUsage();
                    if (!usage || usage.tokens == null) {
                        notify(execCtx, "Context usage unavailable until the next assistant response.", "info");
                        break;
                    }
                    notifyLines(execCtx, [
                        `Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent ?? 0}%)`,
                        `DCP soft limits: min=${ctx.config.compress.minContextLimit} max=${ctx.config.compress.maxContextLimit}`,
                        `Active summary tokens (summaryBuffer=${ctx.config.compress.summaryBuffer}): ${getActiveSummaryTokenUsage(ctx.state)}`,
                    ]);
                    break;
                }
                case "manual": {
                    const arg = parts[1]?.toLowerCase();
                    if (arg === "on" || arg === "off") {
                        ctx.state.manualMode = arg === "on" ? "active" : false;
                        ctx.state.sessionKey = ctx.getSessionKey();
                        await saveSessionState(ctx.state, ctx.logger);
                        notify(execCtx, `Manual mode ${arg === "on" ? "enabled" : "disabled"}.`, "info");
                    } else {
                        notify(execCtx, `Manual mode is currently ${ctx.state.manualMode ? "ON" : "off"}.`, "info");
                    }
                    break;
                }
                case "sweep": {
                    notify(execCtx, "Sweep runs automatically on each compression pass. Deduplication and purge-errors are already applied.", "info");
                    break;
                }
                case "compress": {
                    ctx.onManualCompress(parts.slice(1).join(" ").trim());
                    break;
                }
                default:
                    notify(execCtx, `Unknown /dcp subcommand: ${sub}. Try /dcp help.`, "warning");
            }
        },
    });

    ctx.pi.registerCommand("dcp-compress", {
        description: "Trigger one DCP manual compression pass: /dcp-compress [focus]",
        handler: async (args) => {
            ctx.onManualCompress((args || "").trim());
        },
    });
}

function notify(ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }, message: string, type?: "info" | "warning" | "error"): void {
    ctx.ui.notify(message, type);
}

function notifyLines(ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }, lines: string[]): void {
    ctx.ui.notify(lines.join("\n"), "info");
}

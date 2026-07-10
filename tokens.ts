import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export function countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

export function messageText(message: AgentMessage): string {
    const role = message.role;
    if (role === "user") {
        const content = message.content;
        if (typeof content === "string") return content;
        return content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
    }
    if (role === "assistant") {
        return message.content
            .map((c) => (c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : ""))
            .join("\n");
    }
    if (role === "toolResult") {
        return message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
    }
    return "";
}

export function countMessageTokens(message: AgentMessage): number {
    try {
        return estimateTokens(message);
    } catch {
        return countTokens(messageText(message));
    }
}

import type { DcpMessage } from "./conversation.ts";

export interface ToolTransactionIndex {
    assistantsByCallId: Map<string, DcpMessage[]>;
    resultsByCallId: Map<string, DcpMessage[]>;
}

export function buildToolTransactionIndex(messages: DcpMessage[]): ToolTransactionIndex {
    const assistantsByCallId = new Map<string, DcpMessage[]>();
    const resultsByCallId = new Map<string, DcpMessage[]>();
    for (const entry of messages) {
        if (entry.message.role === "assistant") {
            for (const block of entry.message.content) {
                if (block.type !== "toolCall") continue;
                const owners = assistantsByCallId.get(block.id) ?? [];
                owners.push(entry);
                assistantsByCallId.set(block.id, owners);
            }
        } else if (entry.message.role === "toolResult") {
            const results = resultsByCallId.get(entry.message.toolCallId) ?? [];
            results.push(entry);
            resultsByCallId.set(entry.message.toolCallId, results);
        }
    }
    return { assistantsByCallId, resultsByCallId };
}

export function assistantHasToolCall(entry: DcpMessage): boolean {
    return entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall");
}

export function findLastToolResultForAssistant(messages: DcpMessage[], assistant: DcpMessage): DcpMessage | undefined {
    if (assistant.message.role !== "assistant") return undefined;
    const callIds = new Set(assistant.message.content.filter((block) => block.type === "toolCall").map((block) => block.id));
    let result: DcpMessage | undefined;
    for (const candidate of messages) {
        if (candidate.message.role === "toolResult" && callIds.has(candidate.message.toolCallId)) result = candidate;
    }
    return result;
}

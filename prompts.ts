import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "./logger.ts";

export const SYSTEM_PROMPT = `
You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is \`compress\`. It replaces older conversation content with technical summaries you produce.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

THE PHILOSOPHY OF COMPRESS
\`compress\` transforms conversation content into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

COMPRESS WHEN
A section is genuinely closed and the raw conversation has served its purpose:
- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded without waiting for a whole chapter to close

DO NOT COMPRESS IF
- Raw context is still relevant and needed for edits or precise references
- The target content is still actively in progress
- You may need exact code, error messages, or file contents in the immediate next steps

Before compressing, ask: _"Is this section closed enough to become summary-only right now?"_

Evaluate conversation signal-to-noise REGULARLY. Use \`compress\` deliberately with quality-first summaries. Prioritize stale content intelligently to maintain a high-signal context window that supports your agency.

It is of your responsibility to keep a sharp, high-quality context window for optimal performance.
`;

export const COMPRESS_RANGE_PROMPT = `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, b-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`(bN)\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Compressed block IDs always use the \`bN\` form (never \`mNNNN\`) and are represented in the same XML metadata tag format.

Rules:
- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`(bN)\` placeholders as RESERVED TOKENS. Do not emit \`(bN)\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (not as a placeholder).
- Preflight check before finalizing: the set of \`(bN)\` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`(b2)\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
The same ID tag appears on every message it belongs to — each unique ID identifies one complete message (a user turn, an assistant turn, or a tool result).
Treat these tags as boundary metadata only, not as message content.

Rules:
- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`;

export const COMPRESS_MESSAGE_PROMPT = `Compress individual raw messages into detailed summaries.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity.

USER INTENT FIDELITY
Preserve the user's intent with extra care. Directly quote short user messages when they best preserve exact meaning.

BOUNDARY IDS
\`mNNNN\` IDs identify raw messages (ignore any priority attributes on the metadata tag).
Pick \`messageId\` directly from injected IDs visible in context. Do not invent IDs.

BATCHING
Include one or more messages as separate entries in the \`content\` array of a single tool call.
`;

export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`;

export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for compressible ranges.

If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.
If direction has shifted, compress earlier ranges that are now less relevant.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>
`;

export const ITERATION_NUDGE = `<dcp-system-reminder>
You've been iterating for a while after the last user message.

If there is a closed portion that is unlikely to be referenced immediately (for example, finished research before implementation), use the compress tool on it now.
</dcp-system-reminder>
`;

export const MANUAL_MODE_SYSTEM_EXTENSION = `<dcp-system-reminder>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

Only use the compress tool after seeing \`<compress triggered manually>\` in the current user instruction context.

Issue exactly ONE compress tool per manual trigger. Do NOT launch multiple compress tools in parallel. Each trigger grants a single compression; after it completes, wait for the next trigger.

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</dcp-system-reminder>
`;

export function buildProtectedToolsExtension(protectedTools: string[]): string {
    if (!protectedTools.length) return "";
    const toolList = protectedTools.map((t) => `\`${t}\``).join(", ");
    return `<dcp-system-reminder>
The following tools are environment-managed: ${toolList}.
Their outputs are automatically preserved during compression.
Do not include their content in compress tool summaries — the environment retains it independently.
</dcp-system-reminder>`;
}

export interface RuntimePrompts {
    system: string;
    compressRange: string;
    compressMessage: string;
    contextLimitNudge: string;
    turnNudge: string;
    iterationNudge: string;
    manualExtension: string;
}

const BUNDLED: RuntimePrompts = {
    system: SYSTEM_PROMPT,
    compressRange: COMPRESS_RANGE_PROMPT,
    compressMessage: COMPRESS_MESSAGE_PROMPT,
    contextLimitNudge: CONTEXT_LIMIT_NUDGE,
    turnNudge: TURN_NUDGE,
    iterationNudge: ITERATION_NUDGE,
    manualExtension: MANUAL_MODE_SYSTEM_EXTENSION,
};

export function renderSystemPrompt(
    prompts: RuntimePrompts,
    protectedToolsExtension?: string,
    manual?: boolean,
): string {
    const extensions: string[] = [];
    if (protectedToolsExtension) extensions.push(protectedToolsExtension.trim());
    if (manual) extensions.push(prompts.manualExtension.trim());
    return [prompts.system.trim(), ...extensions]
        .filter(Boolean)
        .join("\n\n")
        .replace(/\n([ \t]*\n)+/g, "\n\n")
        .trim();
}

export const RANGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: [               // One or more ranges to compress
    {
      startId: string,     // Boundary ID at range start: mNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\``;

export const MESSAGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: mNNNN
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // Complete technical summary replacing that one message
    }
  ]
}
\`\`\``;

type EditableField = "system" | "compressRange" | "compressMessage" | "contextLimitNudge" | "turnNudge" | "iterationNudge";

const PROMPT_FILES: Array<{ field: EditableField; file: string }> = [
    { field: "system", file: "system.md" },
    { field: "compressRange", file: "compress-range.md" },
    { field: "compressMessage", file: "compress-message.md" },
    { field: "contextLimitNudge", file: "context-limit-nudge.md" },
    { field: "turnNudge", file: "turn-nudge.md" },
    { field: "iterationNudge", file: "iteration-nudge.md" },
];

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

function stripPromptComments(content: string): string {
    return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(HTML_COMMENT_REGEX, "").trim();
}

function resolvePromptDirs(): { defaultsDir: string; overridesDir: string } {
    const root = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "pi", "dcp-prompts")
        : join(homedir(), ".config", "pi", "dcp-prompts");
    return { defaultsDir: join(root, "defaults"), overridesDir: join(root, "overrides") };
}

export class PromptStore {
    private prompts: RuntimePrompts;
    private readonly dirs = resolvePromptDirs();

    constructor(
        private readonly logger: Logger,
        private readonly customPromptsEnabled: boolean,
    ) {
        this.prompts = { ...BUNDLED };
        if (this.customPromptsEnabled) this.ensureDefaultFiles();
        this.reload();
    }

    getRuntimePrompts(): RuntimePrompts {
        return { ...this.prompts };
    }

    reload(): void {
        const next = { ...BUNDLED };
        if (!this.customPromptsEnabled) {
            this.prompts = next;
            return;
        }
        for (const { field, file } of PROMPT_FILES) {
            const overridePath = join(this.dirs.overridesDir, file);
            if (!existsSync(overridePath)) continue;
            try {
                const raw = readFileSync(overridePath, "utf-8");
                const cleaned = stripPromptComments(raw);
                if (cleaned) next[field] = cleaned;
            } catch {
                this.logger.warn("Failed to read prompt override", { file });
            }
        }
        this.prompts = next;
    }

    private ensureDefaultFiles(): void {
        try {
            mkdirSync(this.dirs.defaultsDir, { recursive: true });
            mkdirSync(this.dirs.overridesDir, { recursive: true });
        } catch {
            return;
        }
        for (const { field, file } of PROMPT_FILES) {
            const content = `${BUNDLED[field].trim()}\n`;
            const filePath = join(this.dirs.defaultsDir, file);
            try {
                const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
                if (existing !== content) writeFileSync(filePath, content, "utf-8");
            } catch {
            }
        }
    }
}

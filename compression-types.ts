import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PluginConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { RuntimePrompts } from "./prompts.ts";
import type { SessionState } from "./types.ts";

export interface CompressionRuntime {
    state: SessionState;
    config: PluginConfig;
    logger: Logger;
}

export interface CompressContext extends CompressionRuntime {
    pi: ExtensionAPI;
    prompts: () => RuntimePrompts;
}

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export interface RangeCompressArgs {
    topic: string;
    content: Array<{ startId: string; endId: string; summary: string }>;
}

export interface MessageCompressArgs {
    topic: string;
    content: Array<{ messageId: string; topic: string; summary: string }>;
}

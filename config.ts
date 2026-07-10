/**
 * DCP configuration.
 *
 * Ported from opencode-dynamic-context-pruning's lib/config.ts, adapted for pi:
 *  - Config search paths follow pi conventions (XDG_CONFIG_HOME/pi, .pi/).
 *  - autoUpdate and pruneNotificationType are intentionally unsupported
 *    (autoUpdate is an npm-package concept; pi has no opencode-style toast/chat split).
 *  - experimental.allowSubAgents is intentionally unsupported: pi has no in-process
 *    subagent sessions. The pi-subagents plugin spawns separate processes that run
 *    their own (independent) DCP instance, so there is nothing to gate here.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Permission = "ask" | "allow" | "deny";
export type CompressMode = "range" | "message";
export type LimitValue = number | `${number}%`;

export interface Deduplication {
    enabled: boolean;
    protectedTools: string[];
}

export interface CompressConfig {
    mode: CompressMode;
    permission: Permission;
    showCompression: boolean;
    summaryBuffer: boolean;
    maxContextLimit: LimitValue;
    minContextLimit: LimitValue;
    modelMaxLimits?: Record<string, LimitValue>;
    modelMinLimits?: Record<string, LimitValue>;
    nudgeFrequency: number;
    iterationNudgeThreshold: number;
    nudgeForce: "strong" | "soft";
    protectedTools: string[];
    protectTags: boolean;
    protectUserMessages: boolean;
}

export interface Commands {
    enabled: boolean;
    protectedTools: string[];
}

export interface ManualModeConfig {
    enabled: boolean;
    automaticStrategies: boolean;
}

export interface PurgeErrors {
    enabled: boolean;
    turns: number;
    protectedTools: string[];
}

export interface TurnProtection {
    enabled: boolean;
    turns: number;
}

export interface ExperimentalConfig {
    /** Allow DCP processing in subagent sessions. Unsupported on pi (no-op). */
    allowSubAgents: boolean;
    customPrompts: boolean;
}

export interface PluginConfig {
    enabled: boolean;
    debug: boolean;
    pruneNotification: "off" | "minimal" | "detailed";
    commands: Commands;
    manualMode: ManualModeConfig;
    turnProtection: TurnProtection;
    experimental: ExperimentalConfig;
    protectedFilePatterns: string[];
    compress: CompressConfig;
    strategies: {
        deduplication: Deduplication;
        purgeErrors: PurgeErrors;
    };
}

/**
 * Tools always protected from dedup/purge pruning. Adapted to pi's ecosystem:
 *   - "subagent" replaces opencode's "task" (the pi-subagents plugin tool)
 *   - "write"/"edit" remain (file mutations are important history)
 *   - "compress" is DCP's own tool
 */
export const DEFAULT_PROTECTED_TOOLS = ["subagent", "compress", "write", "edit"];

/**
 * Tools whose completed outputs are appended to compression summaries.
 * For pi-subagents, the full subagent result text is already in the tool output,
 * so protecting "subagent" preserves it inside the summary.
 */
export const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["subagent"];

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    pruneNotification: "detailed",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    experimental: {
        allowSubAgents: false,
        customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        showCompression: false,
        summaryBuffer: true,
        maxContextLimit: 100000,
        minContextLimit: 50000,
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
        protectTags: false,
        protectUserMessages: false,
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
    },
};

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        manualMode: {
            enabled: config.manualMode.enabled,
            automaticStrategies: config.manualMode.automaticStrategies,
        },
        turnProtection: { ...config.turnProtection },
        experimental: { ...config.experimental },
        protectedFilePatterns: [...config.protectedFilePatterns],
        compress: {
            ...config.compress,
            modelMaxLimits: { ...config.compress.modelMaxLimits },
            modelMinLimits: { ...config.compress.modelMinLimits },
            protectedTools: [...config.compress.protectedTools],
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
        },
    };
}

const GLOBAL_CONFIG_DIR =
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".config", "pi");
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "dcp.jsonc");
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "dcp.json");

function findPiDir(startDir: string): string | null {
    let current = startDir;
    while (true) {
        const candidate = join(current, ".pi");
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

function getConfigPaths(cwd: string): {
    global: string | null;
    configDir: string | null;
    project: string | null;
} {
    const global = existsSync(GLOBAL_CONFIG_PATH_JSONC)
        ? GLOBAL_CONFIG_PATH_JSONC
        : existsSync(GLOBAL_CONFIG_PATH_JSON)
          ? GLOBAL_CONFIG_PATH_JSON
          : null;

    let configDir: string | null = null;
    const piConfigDir = process.env.PI_CONFIG_DIR;
    if (piConfigDir) {
        const jsonc = join(piConfigDir, "dcp.jsonc");
        const json = join(piConfigDir, "dcp.json");
        configDir = existsSync(jsonc) ? jsonc : existsSync(json) ? json : null;
    }

    let project: string | null = null;
    if (cwd) {
        const piDir = findPiDir(cwd);
        if (piDir) {
            const jsonc = join(piDir, "dcp.jsonc");
            const json = join(piDir, "dcp.json");
            project = existsSync(jsonc) ? jsonc : existsSync(json) ? json : null;
        }
    }

    return { global, configDir, project };
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    }
    if (existsSync(GLOBAL_CONFIG_PATH_JSONC) || existsSync(GLOBAL_CONFIG_PATH_JSON)) return;
    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi-dcp/master/dcp.schema.json"
}
`;
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8");
}

/** Strip JSONC comments and trailing commas without a heavy dependency. */
function stripJsonComments(input: string): string {
    let out = "";
    let i = 0;
    let inString = false;
    let stringChar = "";
    while (i < input.length) {
        const ch = input[i];
        const next = input[i + 1];

        if (inString) {
            out += ch;
            if (ch === "\\") {
                out += next ?? "";
                i += 2;
                continue;
            }
            if (ch === stringChar) inString = false;
            i++;
            continue;
        }

        if (ch === '"' || ch === "'") {
            inString = true;
            stringChar = ch;
            out += ch;
            i++;
            continue;
        }

        if (ch === "/" && next === "/") {
            while (i < input.length && input[i] !== "\n") i++;
            continue;
        }

        if (ch === "/" && next === "*") {
            i += 2;
            while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
            i += 2;
            continue;
        }

        out += ch;
        i++;
    }
    // remove trailing commas
    return out.replace(/,(\s*[}\]])/g, "$1");
}

function loadConfigFile(configPath: string): Record<string, any> | null {
    let fileContent: string;
    try {
        fileContent = readFileSync(configPath, "utf-8");
    } catch {
        return null;
    }
    try {
        const stripped = stripJsonComments(fileContent);
        const parsed = JSON.parse(stripped);
        if (parsed === null || parsed === undefined) return null;
        return parsed as Record<string, any>;
    } catch {
        return null;
    }
}

function uniq<T>(...arrays: T[][]): T[] {
    return [...new Set(arrays.flat())];
}

function mergeCompress(base: CompressConfig, override?: Partial<CompressConfig>): CompressConfig {
    if (!override) return base;
    return {
        mode: override.mode ?? base.mode,
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
        modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
        nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
        iterationNudgeThreshold: override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
        nudgeForce: override.nudgeForce ?? base.nudgeForce,
        protectedTools: uniq(base.protectedTools, override.protectedTools ?? []),
        protectTags: override.protectTags ?? base.protectTags,
        protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
    };
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    const override = (path: string) => (data as any)[path];
    return {
        enabled: data.enabled ?? config.enabled,
        debug: data.debug ?? config.debug,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        commands: {
            enabled: data.commands?.enabled ?? config.commands.enabled,
            protectedTools: uniq(
                config.commands.protectedTools,
                (data.commands?.protectedTools as string[] | undefined) ?? [],
            ),
        },
        manualMode: {
            enabled: data.manualMode?.enabled ?? config.manualMode.enabled,
            automaticStrategies:
                data.manualMode?.automaticStrategies ?? config.manualMode.automaticStrategies,
        },
        turnProtection: {
            enabled: data.turnProtection?.enabled ?? config.turnProtection.enabled,
            turns: data.turnProtection?.turns ?? config.turnProtection.turns,
        },
        experimental: {
            allowSubAgents: config.experimental.allowSubAgents, // unsupported on pi; ignored
            customPrompts: data.experimental?.customPrompts ?? config.experimental.customPrompts,
        },
        protectedFilePatterns: uniq(
            config.protectedFilePatterns,
            (data.protectedFilePatterns as string[] | undefined) ?? [],
        ),
        compress: mergeCompress(config.compress, data.compress as Partial<CompressConfig>),
        strategies: {
            deduplication: {
                enabled: data.strategies?.deduplication?.enabled ?? config.strategies.deduplication.enabled,
                protectedTools: uniq(
                    config.strategies.deduplication.protectedTools,
                    (data.strategies?.deduplication?.protectedTools as string[] | undefined) ?? [],
                ),
            },
            purgeErrors: {
                enabled: data.strategies?.purgeErrors?.enabled ?? config.strategies.purgeErrors.enabled,
                turns: data.strategies?.purgeErrors?.turns ?? config.strategies.purgeErrors.turns,
                protectedTools: uniq(
                    config.strategies.purgeErrors.protectedTools,
                    (data.strategies?.purgeErrors?.protectedTools as string[] | undefined) ?? [],
                ),
            },
        },
    };
}

export function getConfig(cwd: string): PluginConfig {
    let config = deepCloneConfig(defaultConfig);
    const paths = getConfigPaths(cwd);

    if (!paths.global) {
        createDefaultConfig();
    }

    const layers = [paths.global, paths.configDir, paths.project];
    for (const path of layers) {
        if (!path) continue;
        const data = loadConfigFile(path);
        if (!data) continue;
        config = mergeLayer(config, data);
    }

    config.compress.nudgeFrequency = Math.max(1, Math.floor(config.compress.nudgeFrequency || 1));
    config.compress.iterationNudgeThreshold = Math.max(
        1,
        Math.floor(config.compress.iterationNudgeThreshold || 1),
    );
    config.strategies.purgeErrors.turns = Math.max(1, Math.floor(config.strategies.purgeErrors.turns || 1));
    config.turnProtection.turns = Math.max(1, Math.floor(config.turnProtection.turns || 1));

    return config;
}

export const CONFIG_DIR = GLOBAL_CONFIG_DIR;

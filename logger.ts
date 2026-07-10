import { writeFile } from "node:fs/promises";
import { existsSync as existsSyncSync, mkdirSync as mkdirSyncSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR =
    process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "pi", "logs", "dcp")
        : join(homedir(), ".config", "pi", "logs", "dcp");

export class Logger {
    readonly enabled: boolean;

    constructor(enabled: boolean) {
        this.enabled = enabled;
    }

    private formatData(data?: any): string {
        if (!data) return "";
        const parts: string[] = [];
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                if (value.length === 0) continue;
                parts.push(
                    `${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`,
                );
            } else if (typeof value === "object") {
                const str = JSON.stringify(value);
                if (str.length < 80) parts.push(`${key}=${str}`);
            } else {
                parts.push(`${key}=${value}`);
            }
        }
        return parts.join(" ");
    }

    private async write(level: string, component: string, message: string, data?: any) {
        if (!this.enabled) return;
        try {
            if (!existsSyncSync(LOG_DIR)) mkdirSyncSync(LOG_DIR, { recursive: true });
            const dailyDir = join(LOG_DIR, "daily");
            if (!existsSyncSync(dailyDir)) mkdirSyncSync(dailyDir, { recursive: true });
            const timestamp = new Date().toISOString();
            const dataStr = this.formatData(data);
            const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? " | " + dataStr : ""}\n`;
            const logFile = join(dailyDir, `${timestamp.split("T")[0]}.log`);
            await writeFile(logFile, logLine, { flag: "a" });
        } catch {
        }
    }

    private caller(skip = 3): string {
        const err = new Error();
        const stack = (err.stack ?? "").split("\n");
        for (let i = skip; i < stack.length; i++) {
            const line = stack[i] ?? "";
            const match = line.match(/(?:\/|^)([^/\\]+)\.[tj]s/);
            if (match && !match[1]!.includes("logger")) return match[1]!;
        }
        return "dcp";
    }

    info(message: string, data?: any) {
        return this.write("INFO", this.caller(), message, data);
    }
    debug(message: string, data?: any) {
        return this.write("DEBUG", this.caller(), message, data);
    }
    warn(message: string, data?: any) {
        return this.write("WARN", this.caller(), message, data);
    }
    error(message: string, data?: any) {
        return this.write("ERROR", this.caller(), message, data);
    }
}

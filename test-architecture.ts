import { readdirSync, readFileSync } from "node:fs";

const MAX_EFFECTIVE_LINES = 400;

function effectiveLines(source: string): number {
    let count = 0;
    let inBlockComment = false;
    for (const rawLine of source.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line) continue;
        while (line) {
            if (inBlockComment) {
                const end = line.indexOf("*/");
                if (end === -1) {
                    line = "";
                    continue;
                }
                inBlockComment = false;
                line = line.slice(end + 2).trim();
                continue;
            }
            if (line.startsWith("//")) {
                line = "";
                continue;
            }
            if (line.startsWith("/*")) {
                inBlockComment = true;
                line = line.slice(2);
                continue;
            }
            count++;
            break;
        }
    }
    return count;
}

const violations = readdirSync(process.cwd())
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, lines: effectiveLines(readFileSync(file, "utf8")) }))
    .filter(({ lines }) => lines >= MAX_EFFECTIVE_LINES)
    .sort((left, right) => right.lines - left.lines);

if (violations.length) {
    throw new Error([
        `TypeScript modules must stay below ${MAX_EFFECTIVE_LINES} effective lines:`,
        ...violations.map(({ file, lines }) => `- ${file}: ${lines}`),
    ].join("\n"));
}

console.log(`ARCHITECTURE TEST PASSED: all TypeScript modules are below ${MAX_EFFECTIVE_LINES} effective lines`);

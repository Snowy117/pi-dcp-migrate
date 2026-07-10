function normalizePath(input: string): string {
    return input.replaceAll("\\\\", "/");
}

function escapeRegExpChar(ch: string): string {
    return /[\\.^$+{}()|\[\]]/.test(ch) ? `\\${ch}` : ch;
}

export function matchesGlob(inputPath: string, pattern: string): boolean {
    if (!pattern) return false;
    const input = normalizePath(inputPath);
    const pat = normalizePath(pattern);

    let regex = "^";
    for (let i = 0; i < pat.length; i++) {
        const ch = pat[i]!;
        if (ch === "*") {
            const next = pat[i + 1];
            if (next === "*") {
                const after = pat[i + 2];
                if (after === "/") {
                    regex += "(?:.*/)?";
                    i += 2;
                    continue;
                }
                regex += ".*";
                i++;
                continue;
            }
            regex += "[^/]*";
            continue;
        }
        if (ch === "?") {
            regex += "[^/]";
            continue;
        }
        if (ch === "/") {
            regex += "/";
            continue;
        }
        regex += escapeRegExpChar(ch);
    }
    regex += "$";
    return new RegExp(regex).test(input);
}

export function getFilePathsFromParameters(tool: string, parameters: unknown): string[] {
    if (typeof parameters !== "object" || parameters === null) return [];
    const params = parameters as Record<string, any>;
    const paths: string[] = [];

    if (Array.isArray(params.edits)) {
        for (const edit of params.edits) {
            if (edit && typeof edit.filePath === "string") paths.push(edit.filePath);
        }
    }

    for (const key of ["path", "filePath", "file"]) {
        const value = params[key];
        if (typeof value === "string") paths.push(value);
    }
    return [...new Set(paths)].filter((p) => p.length > 0);
}

export function isFilePathProtected(filePaths: string[], patterns: string[]): boolean {
    if (!filePaths.length || !patterns.length) return false;
    return filePaths.some((path) => patterns.some((pattern) => matchesGlob(path, pattern)));
}

const GLOB_CHARS = /[*?]/;

export function isToolNameProtected(toolName: string, patterns: string[]): boolean {
    if (!toolName || !patterns.length) return false;
    const exact = new Set<string>();
    const globs: string[] = [];
    for (const pattern of patterns) {
        if (GLOB_CHARS.test(pattern)) globs.push(pattern);
        else exact.add(pattern);
    }
    if (exact.has(toolName)) return true;
    return globs.some((pattern) => matchesGlob(toolName, pattern));
}

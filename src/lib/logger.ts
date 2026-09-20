type Level = "debug" | "info" | "warn" | "error"

export class Logger {
    constructor(private readonly debugEnabled: boolean) {}

    private log(level: Level, message: string, extra?: Record<string, unknown>): void {
        if (level === "debug" && !this.debugEnabled) return
        const suffix = extra ? ` ${JSON.stringify(extra)}` : ""
        console.log(`[dream-memory][${level}] ${message}${suffix}`)
    }

    debug(message: string, extra?: Record<string, unknown>): void {
        this.log("debug", message, extra)
    }

    info(message: string, extra?: Record<string, unknown>): void {
        this.log("info", message, extra)
    }

    warn(message: string, extra?: Record<string, unknown>): void {
        this.log("warn", message, extra)
    }

    error(message: string, extra?: Record<string, unknown>): void {
        this.log("error", message, extra)
    }
}
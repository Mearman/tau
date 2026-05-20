/**
 * Browser console message collector for Playwright Page objects.
 *
 * Attaches a listener to the page's console events and provides formatted
 * output for inclusion in tool results.
 */

import type { Page } from "playwright-core";

export interface ConsoleMessage {
    readonly type: "log" | "warn" | "error" | "info" | "debug";
    readonly text: string;
    readonly location?: string;
}

export interface ConsoleCollector {
    readonly messages: ConsoleMessage[];
    readonly getFormatted: () => string;
}

/**
 * Attach a console listener to the page. Returns the collected messages and
 * a function to retrieve them formatted as a string.
 */
export function collectConsole(page: Page): ConsoleCollector {
    const messages: ConsoleMessage[] = [];
    page.on("console", (msg) => {
        const location = msg.location();
        messages.push({
            type: msg.type() as ConsoleMessage["type"],
            text: msg.text(),
            location: location.url
                ? `${location.url}:${location.lineNumber}`
                : undefined,
        });
    });
    return {
        messages,
        getFormatted: () =>
            messages
                .map((m) => {
                    const loc = m.location ? `  (${m.location})` : "";
                    return `[${m.type}] ${m.text}${loc}`;
                })
                .join("\n"),
    };
}

/** Append collected console logs to output text. */
export function appendConsoleLog(
    text: string,
    consoleCollector: ConsoleCollector
): string {
    const consoleLog = consoleCollector.getFormatted();
    if (!consoleLog) return text;
    const errorCount = consoleCollector.messages.filter(
        (m) => m.type === "error"
    ).length;
    return `${text}\n\n--- Browser Console (${errorCount} error(s)) ---\n${consoleLog}`;
}

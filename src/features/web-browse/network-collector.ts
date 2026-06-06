/**
 * HTTP request/response collector for Playwright Page objects.
 *
 * Attaches listeners to the page's request and response events and provides
 * structured access to all network traffic during a page session.
 *
 * Only stores metadata (URL, method, status, headers) and a truncated
 * body preview to avoid unbounded memory growth on pages with heavy
 * API usage.
 */

import type { Page } from "patchright";

export interface NetworkEntry {
    readonly url: string;
    readonly method: string;
    readonly status: number;
    readonly requestHeaders: Record<string, string>;
    readonly responseHeaders: Record<string, string>;
    /** First 2 KB of response body, if captured. */
    readonly bodyPreview: string;
    readonly contentType: string;
    readonly duration: number;
    readonly timestamp: number;
}

export interface NetworkCollector {
    readonly entries: NetworkEntry[];
    readonly getFormatted: () => string;
    readonly getFiltered: (urlPattern?: string) => NetworkEntry[];
}

const MAX_BODY_PREVIEW = 2048;
const MAX_ENTRIES = 200;

/**
 * Attach network listeners to the page. Returns the collected entries and
 * formatting helpers.
 */
export function collectNetwork(page: Page): NetworkCollector {
    const entries: NetworkEntry[] = [];
    const pendingRequests = new Map<
        import("patchright").Request,
        { startTime: number }
    >();

    page.on("request", (request) => {
        if (entries.length >= MAX_ENTRIES) return;
        pendingRequests.set(request, {
            startTime: Date.now(),
        });
    });

    page.on("response", async (response) => {
        if (entries.length >= MAX_ENTRIES) return;

        const request = response.request();
        const pending = pendingRequests.get(request);
        pendingRequests.delete(request);

        let bodyPreview = "";
        try {
            // Only capture body for text-based responses
            const contentType = response.headers()["content-type"] ?? "";
            if (
                contentType.includes("text/") ||
                contentType.includes("json") ||
                contentType.includes("xml") ||
                contentType.includes("javascript")
            ) {
                const body = await response.text();
                bodyPreview =
                    body.length > MAX_BODY_PREVIEW
                        ? body.slice(0, MAX_BODY_PREVIEW) + "..."
                        : body;
            }
        } catch {
            // Body may not be accessible (e.g. redirects, CORS)
        }

        entries.push({
            url: response.url(),
            method: request.method(),
            status: response.status(),
            requestHeaders: request.headers(),
            responseHeaders: response.headers(),
            bodyPreview,
            contentType: response.headers()["content-type"] ?? "",
            duration: pending ? Date.now() - pending.startTime : 0,
            timestamp: pending?.startTime ?? Date.now(),
        });
    });

    return {
        entries,
        getFormatted: () =>
            entries
                .map(
                    (e) =>
                        `${e.method} ${e.status} ${e.url} (${e.duration}ms, ${e.contentType})`
                )
                .join("\n"),
        getFiltered: (urlPattern) => {
            if (!urlPattern) return entries;
            try {
                const regex = new RegExp(urlPattern, "i");
                return entries.filter((e) => regex.test(e.url));
            } catch {
                // Invalid regex — do substring match
                return entries.filter((e) =>
                    e.url.toLowerCase().includes(urlPattern.toLowerCase())
                );
            }
        },
    };
}

/** Format network entries for inclusion in tool output. */
export function formatNetworkEntries(
    entries: NetworkEntry[],
    verbose = false
): string {
    if (entries.length === 0) return "(no network requests captured)";

    if (!verbose) {
        return entries
            .map(
                (e) =>
                    `${e.method} ${e.status} ${e.url} (${e.duration}ms)`
            )
            .join("\n");
    }

    return entries
        .map((e) => {
            const lines = [
                `${e.method} ${e.status} ${e.url}`,
                `  Content-Type: ${e.contentType}`,
                `  Duration: ${e.duration}ms`,
            ];
            if (e.bodyPreview) {
                lines.push(`  Body: ${e.bodyPreview.slice(0, 200)}`);
            }
            return lines.join("\n");
        })
        .join("\n\n");
}

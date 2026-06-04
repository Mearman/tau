/**
 * Redaction layer for bridge mode output.
 *
 * Mirrors the pattern used by pi-agent-browser-native: strip cookies,
 * auth headers, Bearer tokens, storage state, and other credential-shaped
 * strings from anything the model might read out of a live tab. The page
 * itself is not modified — only what bridge.ts returns to the agent.
 *
 * Two entry points:
 *
 *   - {@link redactText} — apply regex patterns to free-form text. Used
 *     on `getTabText`, the stringified result of `evaluate`, and similar.
 *
 *   - {@link redactJson} — walk a parsed value recursively. Used on
 *     `getAttributes`, structured evaluate results, and any nested JSON
 *     the page might echo back.
 *
 * The patterns and header/key names are derived from a small
 * survey of common auth material (see
 * `docs/design/output-redaction.md` for the rationale). The list is
 * conservative — over-redacting is preferable to leaking a token.
 */

/** Replacement marker for redacted values. */
export const REDACTED = "[REDACTED]";

/** Narrow unknown to a plain object record without assertions. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Header names whose values must never reach the model.
 * Matched case-insensitively against JSON keys and as substrings of
 * "Header: value" text patterns.
 */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
    "x-access-token",
    "x-session-token",
    "x-shopify-token",
    "x-github-token",
    "x-amz-security-token",
]);

/**
 * JSON object keys whose values are credentials. Matched case-insensitively
 * as exact key matches. A "value" here is whatever the page returns —
 * strings, nested objects, or arrays are all redacted.
 */
const SENSITIVE_JSON_KEYS: ReadonlySet<string> = new Set([
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "apiKey",
    "api_key",
    "apikey",
    "token",
    "authToken",
    "auth_token",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "idToken",
    "id_token",
    "privateKey",
    "private_key",
    "sessionId",
    "session_id",
    "sid",
    "csrfToken",
    "csrf_token",
    "xsrfToken",
    "xsrf_token",
    "cookies",
    "set-cookie",
    "setCookie",
    "set_cookie",
    "credentials",
    "bearer",
]);

/**
 * Regex patterns for free-text redaction. Each pattern must include
 * a named `value` group whose match is replaced with {@link REDACTED}.
 */
const TEXT_PATTERNS: ReadonlyArray<{
    description: string;
    pattern: RegExp;
}> = [
    // Authorization / Proxy-Authorization / Cookie / Set-Cookie headers
    {
        description: "HTTP request/response headers",
        pattern:
            /(^|[\s,;{])(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-access-token|x-session-token)\s*:\s*[^\s,;}]+/gi,
    },
    // Bearer / Basic / Token authentication schemes
    {
        description: "Bearer / Basic / Token auth schemes",
        pattern: /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/]+=*/gi,
    },
    // JSON Web Tokens
    {
        description: "JSON Web Token",
        pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    },
    // AWS access key ID
    {
        description: "AWS access key ID",
        pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    },
    // GitHub personal/OAuth tokens
    {
        description: "GitHub token",
        pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    },
    // Slack tokens
    {
        description: "Slack token",
        pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    },
    // Google API key
    {
        description: "Google API key",
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    // Common session cookie names
    {
        description: "Session cookie name/value",
        pattern:
            /\b(PHPSESSID|JSESSIONID|connect\.sid|__Secure-[A-Za-z0-9_-]+|__Host-[A-Za-z0-9_-]+)\s*=\s*[A-Za-z0-9._-]+/g,
    },
    // localStorage / sessionStorage assignment (best-effort)
    {
        description: "Web storage assignment",
        pattern:
            /\b(localStorage|sessionStorage)\.([A-Za-z_$][\w$]*)\s*=\s*("[^"]*"|'[^']*')/g,
    },
    // Key=value or key: "value" with a sensitive key name (e.g. csrf_token=abc...)
    {
        description: "Sensitive key=value pair",
        pattern:
            /\b(api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|csrf[_-]?token|csrf[_-]?nonce|authenticity[_-]?token|api[_-]?secret|auth[_-]?token|auth[_-]?secret|service[_-]?key|private[_-]?key|encryption[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9._+/=:-]{8,}['"]?/gi,
    },
    // Sensitive URL query parameters
    {
        description: "Sensitive URL query parameter",
        pattern:
            /([?&])(token|access_token|api_key|apikey|password|secret|sid|session|key|auth)=([^&\s"'<>]+)/gi,
    },
];

/**
 * Apply all text redaction patterns to a string. Patterns that match
 * are replaced with the {@link REDACTED} marker; the surrounding text
 * is preserved. Returns the input unchanged when no patterns match.
 */
export function redactText(text: string): string {
    if (text.length === 0) return text;
    let result = text;
    for (const { pattern } of TEXT_PATTERNS) {
        result = result.replace(pattern, (match, ...groups: unknown[]) => {
            // Patterns that capture header "name" and value, like
            // "(authorization|...): <value>", want the entire match
            // replaced. Patterns that only match a credential-shaped
            // substring (JWT, API key) likewise.
            //
            // The last capture group is the offset, second-to-last is
            // the full string. We use the original match if the
            // replacement group can't be cleanly extracted.
            const valueGroup = groups[0];
            if (typeof valueGroup === "string" && valueGroup.length > 0) {
                return match.replace(valueGroup, REDACTED);
            }
            return REDACTED;
        });
    }
    return result;
}

/**
 * Recursively redact a value returned by the bridge. Strings have
 * {@link redactText} applied; objects with sensitive keys have their
 * values replaced with {@link REDACTED} (the keys are preserved so the
 * model can still see the structure of what it was looking at).
 */
export function redactJson(value: unknown): unknown {
    return redactValue(value, new WeakSet());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return redactText(value);
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    )
        return value;
    if (Array.isArray(value)) {
        if (seen.has(value)) return REDACTED;
        seen.add(value);
        return value.map((v) => redactValue(v, seen));
    }
    if (isRecord(value)) {
        const obj = value;
        if (seen.has(obj)) return REDACTED;
        seen.add(obj);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (isSensitiveKey(k)) {
                out[k] = REDACTED;
            } else {
                out[k] = redactValue(v, seen);
            }
        }
        return out;
    }
    // functions, symbols, etc — pass through unchanged
    return value;
}

function isSensitiveKey(key: string): boolean {
    const lower = key.toLowerCase();
    if (SENSITIVE_JSON_KEYS.has(lower)) return true;
    if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
    return false;
}

/**
 * Redact a URL string. Sensitive query parameters are stripped (the
 * parameter name is preserved so the shape is visible). Everything
 * else is left as-is.
 */
export function redactUrl(url: string): string {
    if (url.length === 0) return url;
    return url.replace(
        /([?&])(token|access_token|api_key|apikey|password|secret|sid|session|key|auth)=([^&#\s]+)/gi,
        (_match, prefix: string, name: string) => `${prefix}${name}=${REDACTED}`
    );
}

/**
 * Resolution of the Claude Code native binary that the Agent SDK spawns.
 *
 * The SDK ships the binary as a platform-specific optional dependency of
 * `@anthropic-ai/claude-agent-sdk`, but its own auto-resolution is buggy under
 * pnpm strict installs (SDK issues #296, #6867). We bypass it by resolving the
 * platform package ourselves via `createRequire` bound to the SDK's location
 * and passing the path explicitly through `Options.pathToClaudeCodeExecutable`.
 */

import { createRequire } from "node:module";

/**
 * Environment variable that, when set, overrides all candidate resolution.
 * Lets users point at a specific Claude Code binary (e.g. a debug build).
 */
export const CLAUDE_CODE_EXECUTABLE_ENV = "CLAUDE_CODE_EXECUTABLE";

/**
 * Build the ordered list of platform-specific package specifiers that may
 * contain the native binary, most-preferred first. Pure (no I/O) so it can be
 * unit-tested for every supported platform/arch pair.
 *
 * On Linux we try the musl build first (Alpine, Void, musl-based distros) and
 * fall back to the glibc build; other platforms have a single build. Windows
 * binaries carry a `.exe` suffix.
 */
export function claudeCodeExecutableCandidates(
    platform: string,
    arch: string
): string[] {
    const exe = platform === "win32" ? ".exe" : "";
    if (platform === "linux") {
        return [
            `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${exe}`,
            `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${exe}`,
        ];
    }
    return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${exe}`];
}

/**
 * Resolve the Claude Code executable path.
 *
 * Order: explicit `CLAUDE_CODE_EXECUTABLE` override, then the first candidate
 * package resolvable from the SDK's own install location (so nested/pnpm-strict
 * installs are found even without hoisting).
 *
 * @throws if the SDK is not installed, or no platform binary is present.
 */
export function resolveClaudeCodeExecutable(): string {
    const override = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    if (override) return override;

    // import.meta.resolve needs the SDK package to be importable. If it is
    // missing this throws a clear error rather than a cryptic resolver failure.
    let sdkEntryPoint: string;
    try {
        sdkEntryPoint = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    } catch {
        throw new Error(
            "@anthropic-ai/claude-agent-sdk is not installed. Install it with:\n" +
                "  cd ~/.pi/agent/extensions/tau && pnpm add -O @anthropic-ai/claude-agent-sdk"
        );
    }

    const req = createRequire(sdkEntryPoint);
    const candidates = claudeCodeExecutableCandidates(
        process.platform,
        process.arch
    );
    for (const candidate of candidates) {
        try {
            return req.resolve(candidate);
        } catch {
            // Try the next candidate.
        }
    }
    throw new Error(
        `Claude native binary not found for ${process.platform}-${process.arch}. ` +
            "Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, " +
            `or set ${CLAUDE_CODE_EXECUTABLE_ENV} to an explicit path.`
    );
}

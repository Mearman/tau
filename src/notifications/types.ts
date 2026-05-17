/**
 * Notification provider interface and registry types.
 *
 * Each provider (terminal, pushover, etc.) implements this interface and
 * registers itself with the NotificationRegistry. The registry dispatches
 * notifications to all enabled, configured providers.
 */

/** A single notification provider. */
export interface NotificationProvider {
    /** Unique identifier (e.g. "terminal", "pushover"). */
    readonly id: string;

    /** Human-readable name for the settings UI. */
    readonly label: string;

    /**
     * Names of credential/settings fields this provider requires.
     * Stored as `notificationProviderConfig.<providerId>.<fieldName>`.
     */
    readonly fields: NotificationField[];

    /**
     * Resolve the effective config for this provider.
     * Checks environment variables first (declared on each field),
     * then falls back to stored config values.
     */
    resolveConfig(storedConfig: Record<string, string>): Record<string, string>;

    /**
     * Send a notification. Fire-and-forget — errors are logged, not thrown.
     *
     * @param request  The notification to send.
     * @param config   This provider's resolved settings (env vars + stored).
     */
    send(request: NotificationRequest, config: Record<string, string>): void;

    /**
     * Whether this provider has all required fields populated.
     * Providers with empty optional fields are still considered configured.
     */
    isConfigured(config: Record<string, string>): boolean;
}

export interface NotificationRequest {
    title: string;
    body: string;
    persistent: boolean;
}

export interface NotificationField {
    /** Field name used as the key in the provider's config record. */
    name: string;
    /** Human-readable label for the settings UI. */
    label: string;
    /** Whether this field must be non-empty for the provider to be considered configured. */
    required: boolean;
    /** Hint text shown below the input in the settings UI. */
    hint?: string;
    /**
     * Environment variable name checked before stored config.
     * When set, the provider reads from the env var first.
     */
    envVar?: string;
}

/** Persisted state for the notification subsystem. */
export interface NotificationConfig {
    persistent: boolean;
    respectDnd: boolean;
    /** IDs of enabled providers. */
    enabledProviders: string[];
    /** Per-provider credential/settings storage. */
    providerConfigs: Record<string, Record<string, string>>;
}

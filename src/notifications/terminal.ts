/**
 * Terminal notification provider.
 *
 * Sends notifications via terminal escape sequences:
 * - Windows Terminal: PowerShell toast
 * - Kitty: OSC 99 with urgency
 * - Others (Ghostty, iTerm2, WezTerm): OSC 777
 */

import { execFile } from "node:child_process";
import type { NotificationProvider, NotificationRequest } from "./types.ts";

function windowsToastScript(title: string, body: string): string {
    const type = "Windows.UI.Notifications";
    const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
    const template = `[${type}.ToastTemplateType]::ToastText01`;
    const toast = `[${type}.ToastNotification]::new($xml)`;
    return [
        `${mgr} > $null`,
        `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
        `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
        `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
    ].join("; ");
}

export const terminalProvider: NotificationProvider = {
    id: "terminal",
    label: "Terminal",
    fields: [],

    resolveConfig(): Record<string, string> {
        return {};
    },

    isConfigured(): boolean {
        return true;
    },

    send(request: NotificationRequest, _config: Record<string, string>): void {
        const { title, body, persistent } = request;
        if (process.env.WT_SESSION) {
            execFile("powershell.exe", [
                "-NoProfile",
                "-Command",
                windowsToastScript(title, body),
            ]);
        } else if (process.env.KITTY_WINDOW_ID) {
            const urgency = persistent ? "1" : "0";
            process.stdout.write(`\x1b]99;i=1:d=${urgency};${title}\x1b\\`);
            process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
        } else {
            process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
        }
    },
};

# Pi Chrome Bridge — Privacy Policy

**Last updated: 20 May 2026**

## Data Collection

Pi Chrome Bridge does **not** collect, store, or transmit any personal data to external servers.

## How It Works

- The extension runs entirely on your local machine
- It communicates with a native messaging host (a process on your computer) via Chrome's native messaging API
- The native messaging host opens a Unix domain socket on your machine for local tools to connect to
- No data is sent to any remote server

## Permissions

The extension requests the following permissions:

| Permission | Purpose |
|---|---|
| `tabs` | List open tabs and their titles/URLs |
| `activeTab` | Access the currently active tab |
| `scripting` | Extract text content and evaluate JavaScript in tabs |
| `debugger` | Attach Chrome DevTools Protocol debugger (for advanced operations) |
| `nativeMessaging` | Communicate with the local native messaging host |
| `alarms` | Keep the service worker alive |

All data accessed by these permissions stays on your machine and is relayed only to the local native messaging host process.

## Third Parties

No third-party services, analytics, or advertising SDKs are used.

## Contact

For questions about this policy, open an issue at the project repository.

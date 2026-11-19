# 🔒 Security Policy

## Reporting a vulnerability
Please **do not** open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/XDavidT/MongBoard/security/advisories/new) instead. You'll get a reply within a few days.

## How MongBoard handles secrets
- Passwords are stored in the macOS Keychain (service `io.mongboard.connections`).
- Saved connection strings have credentials stripped before they're written to disk.
- No telemetry: the app only connects to the databases you configure.

## Supported versions
Only the latest release receives security fixes.

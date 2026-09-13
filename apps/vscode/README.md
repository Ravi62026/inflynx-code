# Inflynx Code for VS Code

Production-grade autonomous AI coding agent directly integrated into Visual Studio Code.

## Features

- ⚡ **Autonomous Coding Agent**: Execute complex tasks, multi-file refactoring, bug fixes, and test generation directly inside your editor.
- 💬 **Interactive Chat Sidebar**: Streaming agent responses, live thought deltas, inline code execution, and `@file` context mentions.
- 🛡️ **Human-in-the-Loop Tool Approval**: Review diffs and execute shell commands with explicit approval safeguards before applying changes.
- 📊 **Visual Planning & Tool Tree**: Real-time visualization of task DAG steps, active execution status, and loaded MCP/core tools.
- 🔋 **Live Budget & Mode Indicators**: Monitor turn counts, token usage, and active operational mode (`ask`, `plan`, `agent`, `debug`) directly in the status bar.
- 🔍 **Diagnostics & CodeActions**: Contextual lightbulb fixes and right-click refactoring actions for selected code or compiler diagnostics.

## Requirements

The extension communicates with the Inflynx Code backend server (`apps/server`), which will automatically start when the extension activates (or connect to an existing server running at `http://localhost:4000`).

## Extension Settings

* `inflynx.serverUrl`: URL of the Inflynx backend server (default: `http://localhost:4000`).
* `inflynx.autoStartServer`: Automatically launch the backend server if not running (default: `true`).
* `inflynx.defaultMode`: Default operational mode (`agent`, `ask`, `plan`, `debug`).
* `inflynx.defaultBudget`: Budget constraint tier (`low`, `medium`, `high`, `max`).

## License

MIT

# Harness installation

## Interactive wizard (directly to your harness)

`smooth-operator install <harness>` is interactive by default — it asks exactly 3
curated questions (browser mode/profile, browser executable, and
security/data-directory settings) with recommended defaults in brackets.
Omitting `<harness>` is allowed too: on a TTY the installer prompts for the
target first (default `opencode`), while piped or CI environments print usage
and exit instead. Use `smooth-operator install opencode --yes` to skip prompts
and use recommended defaults. The wizard normalizes and validates its choices
before saving them to `~/.smooth-operator/config.json` (0600, bounded,
owner-only, and symlink-safe). Managed mode owns one private persistent profile;
connect mode attaches to an operator-owned browser and does not own or close
its profile/process. Personal-Chrome mode derives `browserUrl` after launching
the helper on port 9222; it is not a separate prompt.

### Personal Chrome (connect) helper

When you pick “connected browser” (mode `connect`), the wizard finds Chromium via
`discovery.ts`, launches a dedicated debugging profile under
`~/.smooth-operator/personal-chrome` with port `9222`, and polls the loopback
endpoint until it is live. On success it writes
`SMOOTH_OPERATOR_BROWSER_MODE=connect` and
`SMOOTH_OPERATOR_BROWSER_URL=http://127.0.0.1:9222` for you. This does not
attach to or take ownership of an operator's daily browser profile. No manual
`9222` knowledge is needed. Non-interactive environments (no TTY or `CI` set)
skip prompts entirely and apply the same recommended defaults as `--yes`. The
`chrome://inspect` toggle remains as an advanced opt-in (see
`docs/mcp-server.md`).

SmoothOperator speaks MCP over stdio. The `smooth-operator install <target>`
command registers that stdio server with a supported client. It uses
structured argument arrays and never invokes a shell.

The server also supports Streamable HTTP at `/mcp` for harnesses that cannot
launch local stdio processes. Its HTTP adapter accepts current MCP sessions and
the SDK's legacy 2025-compatible handshake, while retaining host, origin,
authentication, and request-size checks. For a local harness that needs an
explicit path, use a structured command such as:

```text
smooth-operator --config /absolute/path/to/config.json
```

The installer-created `~/.smooth-operator/config.json` is discovered
automatically, so an explicit `--config` argument is only needed for a separate
profile or an unusual home/config location.

Build or install the package first:

```sh
npm run build
npm install -g .
smooth-operator install --help
```

The supported targets are `claude-code`, `opencode`, `copilot`, `codex`,
`gemini`, `vscode`, `cursor`, `windsurf`, and `claude-desktop`. Aliases such as
`claude`, `github-copilot`, `codex-cli`, `gemini-cli`, and `vs-code` are also
accepted.

## How the installer chooses a server command

For CLI clients, the installer passes the client's documented MCP command an
argv equivalent of:

```text
smooth-operator
```

When the command is run from the published npm bundle, GUI-oriented JSON
entries use:

```text
/absolute/path/to/node /absolute/path/to/dist/smooth-operator.mjs
```

as two structured fields (`command` and `args`). This avoids relying on the
GUI application's PATH. If you create a config by hand, use the absolute form
when the client is launched outside your shell. A path containing spaces is
safe because it is stored as an argument, not a shell command string.

The installer does not include environment secrets in generated entries. Set
server settings in the harness environment or in the harness's documented
environment map as appropriate.

## Claude Code

The current Claude Code CLI supports a non-interactive stdio command:

```sh
claude mcp add --scope user SmoothOperator -- smooth-operator
```

The installer runs that command with each token as a separate argument. Verify
the result with:

```sh
claude mcp get SmoothOperator
claude mcp list
```

`--scope user` stores the server in the user configuration for all projects.
Use the CLI directly with `--scope project` when the entry belongs in a
repository's `.mcp.json`, because the installer intentionally does not write
project files without an explicit project target.

Official reference: <https://code.claude.com/docs/en/mcp>.

## OpenCode

The current OpenCode CLI's `opencode mcp add` command opens an interactive
form. Passing `opencode mcp add SmoothOperator -- smooth-operator` is not a stable
non-interactive interface, so the installer does not invoke it. Instead, it
edits the documented JSON/JSONC config atomically and reports the path:

```sh
smooth-operator install opencode
```

The default global path is `~/.config/opencode/opencode.json`. If
`OPENCODE_CONFIG` is set, that file is used. `OPENCODE_CONFIG_DIR` selects the
config directory; an existing `opencode.jsonc` is preferred when the default
`opencode.json` is absent.
An explicitly selected `OPENCODE_CONFIG` (or test/config-path override) is
always used exactly, even when a sibling `opencode.jsonc` exists.

For a new or current v2 config, the installer writes:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "SmoothOperator": {
        "type": "local",
        "command": ["smooth-operator"]
      }
    }
  }
}
```

If an existing config has the older server-name-directly-under-`mcp` shape,
the installer preserves that shape and writes the compatible local entry with
`enabled: true`. In the v2 `mcp.servers` shape, `disabled` is optional and
defaults to `false`; a matching entry with `disabled: false` or no `disabled`
field is idempotent, while `disabled: true` is an explicit conflict. In the
legacy shape, `enabled` defaults to `true`; `enabled: false` is likewise an
explicit conflict. If it has malformed `mcp` or malformed `mcp.servers`,
installation fails closed rather than replacing user data.
Comments and trailing commas are accepted as JSONC; a successful update writes
normalized JSON and creates a unique owner-only backup first.

After editing, run `opencode mcp list` or restart OpenCode. OpenCode also
supports adding the server interactively with `opencode mcp add`; that is the
official fallback when an administrator requires OpenCode to own the write.

Official references: <https://opencode.ai/v2/docs/mcp-servers> and
<https://opencode.ai/docs/cli/>.

## GitHub Copilot CLI

The current Copilot CLI accepts a non-interactive local stdio command:

```sh
copilot mcp add SmoothOperator -- smooth-operator
copilot mcp get SmoothOperator
copilot mcp list
```

The persistent user configuration is normally `~/.copilot/mcp-config.json`.
`COPILOT_HOME` changes that directory. Copilot's interactive `/mcp add` form
is available if you need environment variables, a tool filter, or a remote
HTTP server. The installer only adds the local server and does not guess at
those optional settings.

Official references: <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
and <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>.

## Codex CLI

Codex's current command for a global local server is:

```sh
codex mcp add SmoothOperator -- smooth-operator
codex mcp get SmoothOperator
codex mcp list
```

The entry is written to the user's Codex configuration (normally
`~/.codex/config.toml`). The installer targets the global scope. For a project
configuration, run the command from the project using the Codex-supported
project configuration mechanism and review the resulting TOML before sharing
it.

Official reference: <https://developers.openai.com/codex/mcp>.

## Gemini CLI

Gemini CLI's current command places the server name and command before the
scope option:

```sh
gemini mcp add SmoothOperator smooth-operator --scope user
gemini mcp list
```

The installer uses this positional form. Gemini stores user settings under its
user settings directory; use `gemini mcp list` to confirm the selected scope.
The interactive `/mcp` command can reload servers after a configuration change.

Official references: <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md>
and <https://google-gemini.github.io/gemini-cli/docs/cli/tutorials.html>.

## Visual Studio Code

VS Code's CLI accepts a JSON server definition:

```sh
code --add-mcp '{"name":"SmoothOperator","command":"smooth-operator","args":[]}'
```

The installer sends one JSON argument to `code --add-mcp`, not a shell-quoted
string assembled from user input. MCP server configuration is managed by
VS Code's MCP settings UI and command-line integration.

Official reference: <https://code.visualstudio.com/docs/copilot/chat/mcp-servers>.

## Cursor, Windsurf, and Claude Desktop

These clients use JSON configuration files, so the installer performs a
careful merge and writes atomically.

| Target | Default path |
| --- | --- |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%/Claude/claude_desktop_config.json` |
| Claude Desktop (Linux) | `${XDG_CONFIG_HOME:-~/.config}/Claude/claude_desktop_config.json` |

The generated shape for these clients is:

```json
{
  "mcpServers": {
    "SmoothOperator": {
      "command": "smooth-operator",
      "args": []
    }
  }
}
```

When run from the packaged executable, `command` is the absolute Node path and
`args` contains the absolute bundled entrypoint, which is more reliable for a
GUI launch environment. Existing unrelated server entries are preserved.

The installer accepts JSONC comments and trailing commas, rejects malformed
roots and non-object `mcpServers`, rejects a conflicting existing
`SmoothOperator` entry, and refuses symlinked config files/directories. For an
existing file it creates an exclusive backup named `.bak`, `.bak.1`, and so on;
it never overwrites an earlier backup. Config and backup files are written with
owner-only permissions where the platform supports them.

Restart the client after editing. Claude Desktop may require a full quit and
relaunch; Cursor and Windsurf can reload MCP settings from their respective
MCP panels.

## Manual fallback and cleanup

If a harness is not listed or its CLI schema has changed, inspect its official
MCP documentation and add the same stdio entry manually. Do not paste a shell
string into a field that expects an executable plus an argument array.

To remove the server, use the harness's removal command when available:

```sh
claude mcp remove SmoothOperator
copilot mcp remove SmoothOperator
codex mcp remove SmoothOperator
gemini mcp remove SmoothOperator
```

For JSON clients, remove only the `SmoothOperator` property and leave unrelated
settings intact. Keep a backup until the client starts successfully without
the server. Uninstalling the npm package does not remove any harness config,
downloaded files, browser profile, or backup; clean those separately after
review.

## Troubleshooting

- **`command not found`:** install the package globally or use an absolute
  Node-plus-bundle entry. A GUI application may not inherit your shell PATH.
- **CLI rejects the command:** check the official client version and inspect
  `--help`; use the exact argv printed by the installer error or edit the
  config manually. OpenCode's add command is intentionally interactive.
- **Existing config is rejected:** inspect the file for malformed JSON,
  non-object `mcpServers`/`mcp` values, a symlink, or a conflicting
  `SmoothOperator` entry. The fail-closed behavior protects unrelated settings.
- **No tools after installation:** close and restart the harness, then list
  its MCP servers. Run `smooth-operator --version` directly to verify the
  executable before debugging the harness.
- **A backup already exists:** the installer uses `.bak.1`, `.bak.2`, and so on;
  inspect the returned path instead of assuming `.bak` was replaced.

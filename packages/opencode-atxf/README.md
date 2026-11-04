# @leostera/opencode-atxf

[OpenCode](https://opencode.ai) TUI plugin for [ATXF](https://atxf.leostera.dev). It exports and imports sessions,
and joins a session shared with other agents, such as Pi with [`@leostera/pi-atxf`](../pi-atxf), through one ATXF
file. Needs OpenCode 2.

```sh
opencode plugin add @leostera/opencode-atxf
```

For a local checkout, list the package directory in `~/.config/opencode/cli.json`:

```json
{ "plugins": ["/path/to/atxf/packages/opencode-atxf"] }
```

## Commands

| Command              | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| `/atxf export [file]` | Writes this session as ATXF. The default file is `./<session id>.atxf.jsonl`.    |
| `/atxf import <file>` | Opens an ATXF session, written by any agent, as a new OpenCode session.          |
| `/atxf join <file>`   | Shares this session through `<file>`. If the file already holds a session, this session is replaced by a copy of it. |
| `/atxf sync`          | Exchanges turns with the shared file now.                                        |
| `/atxf leave`         | Stops sharing.                                                                   |
| `/atxf status`        | Shows the file this session is joined to.                                        |

## How joining works

When a joined session finishes a turn, the plugin pushes its new records to the shared file. The push reconciles
the file under a lock (SPEC §18), so turns from agents that push at the same time are all kept. The plugin also
watches the file. When another agent pushes, and the session is idle, the plugin pulls: it reconciles the file with
the session, then deletes the session and imports the result under the same id. Turns that arrive while OpenCode is
working are pulled once the turn ends. Joins are kept in `$XDG_STATE_HOME/atxf/joins.json`.

The plugin runs in the TUI, not the server, because only the TUI plugin API can export, import and delete sessions
and then show the session again. OpenCode loads a TUI plugin from the package's `tui` entry.

## Testing

`bun packages/opencode-atxf/test/e2e.ts` runs a real OpenCode TUI in tmux against a scripted model, with temporary
XDG directories. `bun test/e2e/pi-opencode.ts` runs one session across Pi and OpenCode.

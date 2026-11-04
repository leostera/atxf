# @leostera/pi-atxf

[Pi](https://github.com/earendil-works/pi) extension for [ATXF](https://atxf.leostera.dev). It exports and imports
sessions, and joins a session shared with other agents, such as OpenCode with
[`@leostera/opencode-atxf`](../opencode-atxf), through one ATXF file.

```sh
pi install npm:@leostera/pi-atxf
```

## Commands

| Command              | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| `/atxf export [file]` | Writes this session as ATXF. The default file is `./<session id>.atxf.jsonl`.    |
| `/atxf import <file>` | Opens an ATXF session, written by any agent, as a new Pi session.                |
| `/atxf join <file>`   | Shares this session through `<file>`. If the file already holds a session, Pi opens a copy of it instead. |
| `/atxf sync`          | Exchanges turns with the shared file now.                                        |
| `/atxf leave`         | Stops sharing.                                                                   |
| `/atxf status`        | Shows the file this session is joined to.                                        |

## How joining works

After each turn, Pi pushes its new records to the shared file. The push reconciles the file under a lock (SPEC §18),
so turns from agents that push at the same time are all kept. Pi also watches the file. When another agent pushes,
and Pi is idle, Pi pulls: it reconciles the file with its session, rewrites the session file and reopens it. Turns
that arrive while Pi is working are pulled once the turn ends. Pi remembers joins in
`$XDG_STATE_HOME/atxf/joins.json`, so a session stays joined after Pi restarts.

Pi can replace the open session only from a command, so automatic pulls start after you run an `/atxf` command in
that Pi process, such as `/atxf join`.

## Testing

`bun packages/pi-atxf/test/e2e.ts` runs a real Pi in RPC mode against a scripted model, with its own temporary
agent directory. `bun test/e2e/pi-opencode.ts` runs one session across Pi and OpenCode.

# claude-code-resume

> Installs as the `ccresume` command — short prefix, no collision with `claude`.

fzf-style tree picker for Claude Code sessions, grouped by cwd with **highlighted-match preview** so you can confirm the right session before selecting it.

Inspired by Claude Code's built-in `/resume` picker, but adds a live preview pane that scrolls through every message body matching your query — so you don't have to open the wrong session twice.

## Why

Claude Code's `/resume` only does substring matching against title / branch / tag / PR — it can't tell you *why* a session matched, and it doesn't look inside the transcript at all. This tool:

- **searches the full transcript body**, not just metadata
- groups sessions by directory, showing the most recent 10 per directory by default
- shows the current git branch on directory rows, and only shows a session's recorded branch when it differs
- **highlights matches inline** in a preview pane (right side or bottom)
- shows surrounding context per match so you can verify intent
- scans every Claude Code project on disk by default

## Install

```bash
brew install fzf            # macOS; on Linux use apt/pacman/dnf
bun install                 # in this dir, just to mark engines
bun run install:local       # builds a single binary into ~/.local/bin
```

Or symlink the source if you prefer no build step:

```bash
chmod +x src/claude-code-resume.ts
ln -sf "$PWD/src/claude-code-resume.ts" ~/.local/bin/ccresume
```

Requires `bun >= 1.1` and `fzf >= 0.40`. Clipboard support is auto-detected: `pbcopy` on macOS, `clip` on Windows, `wl-copy`/`xclip`/`xsel` on Linux. Without one of these the `ctrl-y` binding is silently disabled — everything else still works.

## Usage

```bash
ccresume                              # pick + resume (cd to cwd, exec `claude --resume`)
ccresume wsgi.input                   # pre-fill the query
ccresume --no-transcript              # skip transcript-body indexing (faster, metadata only)
ccresume --action id                  # print sessionId to stdout instead of resuming
ccresume --action path                # print full .jsonl path
ccresume --action copy                # copy sessionId to clipboard
ccresume --dump                       # debug: print the tree TSV fed to fzf, then exit
ccresume --version
```

Default action: `resume` — pick a session, then directly exec `claude --resume <id>` in that session's cwd. Pass `--action id` (or `both`) when you want raw output for shell composition:

```bash
claude --resume "$(ccresume --action id)"             # explicit id output
read cwd id <<< "$(ccresume --action both)"           # then: cd "$cwd" && claude --resume "$id"
```

## Passing options to fzf

Unknown flags are forwarded to fzf verbatim. fzf options that take a value must use `--flag=value` form (or sit after `--`), because ccresume can't tell unfamiliar value flags from boolean ones.

By default, the preview pane auto-switches between right-side and bottom layouts from the current terminal width/height ratio, and recalculates on terminal resize. Passing `--preview-window=...` disables that auto layout for the invocation.

```bash
# layout
ccresume --preview-window=down:70%:wrap
ccresume --height=80% --layout=default

# matching behavior
ccresume --exact                    # exact-match only
ccresume --algo=v1                  # faster, less smart matching
ccresume +i                         # case-sensitive

# input/UI
ccresume --no-mouse                 # disable mouse capture
ccresume --color=bw                 # monochrome
ccresume --bind=ctrl-r:reload(echo)

# anything tricky → put it after --
ccresume "myquery" -- --preview-window=hidden --no-mouse
```

Common fzf options worth knowing about:

| flag | what it does |
|---|---|
| `--preview-window=POS:SIZE%:wrap` | preview position/size (`right`, `down`, `up`, `left`, `hidden`) |
| `--height=N%` / `--height=N` | shrink fzf below full-screen |
| `--bind=KEY:ACTION` | rebind any key; see `man fzf` for actions |
| `--exact` | only exact-substring matches |
| `--algo=v1` | older, faster fuzzy algorithm |
| `+i` / `--no-ignore-case` | case-sensitive matching |
| `--tac` | reverse input order |
| `--no-mouse` | disable mouse, recover native terminal text selection |
| `--color=bw` | monochrome |

`FZF_DEFAULT_OPTS` is respected — your dotfile defaults apply. `FZF_DEFAULT_COMMAND` is ignored (ccresume feeds fzf via stdin).

> Tip: don't pass `-q` to ccresume; bare positionals are the query.

## Inside fzf

| key      | action                                    |
|----------|-------------------------------------------|
| `enter` / double-click | directory: collapse/expand; `[+10]` row: show 10 more; session: select |
| `ctrl-/` | flip preview position (right / bottom / hidden) |
| `ctrl-y` | copy sessionId to clipboard + abort       |
| `alt-t`  | toggle preview: filtered ↔ full transcript |
| `esc`    | cancel                                    |

Override any binding with `--bind=key:action`.

Preview pane scrolling: mousewheel (terminal-dependent), `shift-↑` / `↓` for one line, `PgUp` / `PgDn` for one screen.

Search syntax is fzf's default: space-separated AND tokens, `'word` exact, `^prefix`, `suffix$`, `!negate`, `a | b` OR. See `man fzf`.

## How it works

1. Scans every Claude Code project directory under `~/.claude/projects/`, then collects UUID-named `.jsonl` session files from each project.
2. Parses each session file (concurrency capped at 32 to keep fd count sane): extracts metadata (`custom-title`, `tag`, `summary`, `last-prompt`, `agent-name`, `gitBranch`) and concatenates user/assistant message text into a searchable body (capped at 200KB/session).
3. Reads each directory's current git branch once, writes a per-picker tree state file, then runs fzf in `--disabled` mode as a display shell. Directory rows are expanded by default and can be collapsed/expanded with `enter` or double-click. Each expanded directory initially shows only the first 10 visible sessions plus a `[+10] show 10 more` row when more are available. Session rows only show their recorded `gitBranch` when it differs from the directory's current branch.
4. On every query change, fzf reloads rows via the internal `render-tree` subcommand. That subcommand performs a full-session search by feeding metadata + transcript text into `fzf --filter`, so fzf's own query syntax and ranking are reused while the visible rows stay display-only.
5. On a directory row, `enter` / double-click toggles collapse/expand. On a `[+10]` row, it increases that directory's visible session limit by 10. On a session row, it emits sessionId / path / cwd / both to stdout (or copies / execs `claude --resume`).
6. The preview pane uses `preview-item`: directory rows show matching sessions when a query is active, otherwise recent sessions; session rows read the transcript and print matching message windows. `alt-t` flips a per-invocation state file via `toggle-mode`, switching session preview to a full-transcript view with the same highlighting.

Sidechain sessions (subagent transcripts), team-spawned sessions, and empty shells are filtered out — same behavior as `/resume`.

## File layout

```
src/claude-code-resume.ts        single-file launcher + preview subcommand (pure helpers exported)
tests/parse.test.ts     bun test fixtures — pin encodeCwd, parsing, and highlighting
package.json            build/install scripts
```

No build step required to run from source. `bun run install:local` compiles a standalone binary to `~/.local/bin/ccresume` if you want a Bun-free deploy.

## Development

```bash
bun test          # run the test suite
bun start         # run from source
bun run build     # produce dist/ccresume (compiled binary)
```

## License

MIT.

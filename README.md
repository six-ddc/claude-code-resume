# claude-code-resume

> Installs as the `ccresume` command — short prefix, no collision with `claude`.

fzf-style picker for Claude Code sessions, with **highlighted-match preview** so you can confirm the right session before selecting it.

Inspired by Claude Code's built-in `/resume` picker, but adds a live preview pane that scrolls through every message body matching your query — so you don't have to open the wrong session twice.

## Why

Claude Code's `/resume` only does substring matching against title / branch / tag / PR — it can't tell you *why* a session matched, and it doesn't look inside the transcript at all. This tool:

- **searches the full transcript body**, not just metadata
- **highlights matches inline** in a preview pane (right side or bottom)
- shows surrounding context per match so you can verify intent
- defaults to the current cwd (mirrors Claude Code's per-project session storage)

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
ccresume --all                        # every project on disk (resume still cds into its cwd)
ccresume --cwd /path/to/proj          # specific cwd
ccresume --no-transcript              # skip transcript-body indexing (faster, metadata only)
ccresume --action id                  # print sessionId to stdout instead of resuming
ccresume --action path                # print full .jsonl path
ccresume --action copy                # copy sessionId to clipboard
ccresume --dump                       # debug: print the TSV fed to fzf, then exit
ccresume --version
```

Default action: `resume` — pick a session, then directly exec `claude --resume <id>` in that session's cwd. Pass `--action id` (or `both`) when you want raw output for shell composition:

```bash
claude --resume "$(ccresume --action id)"             # explicit id output
read cwd id <<< "$(ccresume --all --action both)"     # then: cd "$cwd" && claude --resume "$id"
```

## Passing options to fzf

Unknown flags are forwarded to fzf verbatim. fzf options that take a value must use `--flag=value` form (or sit after `--`), because ccresume can't tell unfamiliar value flags from boolean ones.

```bash
# layout
ccresume --preview-window=down:70%:wrap
ccresume --height=80% --layout=default

# matching behavior
ccresume --exact                    # exact-match only
ccresume --algo=v1                  # faster, less smart matching
ccresume --case-sensitive

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
| `--tac` | reverse input order |
| `--no-mouse` | disable mouse, recover native terminal text selection |
| `--color=bw` | monochrome |

`FZF_DEFAULT_OPTS` is respected — your dotfile defaults apply. `FZF_DEFAULT_COMMAND` is ignored (ccresume feeds fzf via stdin).

> Tip: don't pass `-q` to ccresume; bare positionals are the query.

## Inside fzf

| key      | action                                    |
|----------|-------------------------------------------|
| `enter`  | select                                    |
| `ctrl-/` | flip preview position (right / bottom / hidden) |
| `ctrl-y` | copy sessionId to clipboard + abort       |
| `alt-t`  | toggle preview: filtered ↔ full transcript |
| `esc`    | cancel                                    |

Override any binding with `--bind=key:action`.

Preview pane scrolling: mousewheel (terminal-dependent), `shift-↑` / `↓` for one line, `PgUp` / `PgDn` for one screen.

Search syntax is fzf's default: space-separated AND tokens, `'word` exact, `^prefix`, `suffix$`, `!negate`, `a | b` OR. See `man fzf`.

## How it works

1. Resolves the project dir from cwd using Claude Code's own sanitization (`/foo bar` → `-foo-bar`) under `~/.claude/projects/`. The rule is duplicated in `encodeCwd()`; tests in `tests/parse.test.ts` pin the contract to catch upstream drift.
2. Parses every `.jsonl` session file (concurrency capped at 32 to keep fd count sane): extracts metadata (`custom-title`, `tag`, `summary`, `last-prompt`, `agent-name`, `gitBranch`) and concatenates user/assistant message text into a searchable body (capped at 200KB/session).
3. Streams TSV rows to `fzf`: `display+haystack \t sessionId \t path \t cwd`. `fzf` matches against the merged first column (display has ANSI; haystack is plain) and shows the display segment.
4. On every keystroke, `fzf` re-invokes `ccresume preview <id> <path> <query>` (an internal subcommand) for the focused row. The preview reads the transcript once and prints every message containing all query tokens (case-insensitive AND) with **±200 char windows and ANSI highlighting**. `alt-t` flips a per-invocation state file via the internal `toggle-mode` subcommand, switching to a full-transcript view with the same highlighting.
5. On `enter`, the action emits sessionId / path / cwd / both to stdout (or copies / execs `claude --resume`).

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

#!/usr/bin/env bun
// ccresume (claude-code-resume) — fzf-style picker for Claude Code sessions
//
// ccresume options:
//   --all                  search every project on disk
//   --cwd <path>           specific project cwd (default: $PWD)
//   --no-transcript        skip transcript-body indexing (faster, metadata only)
//   --action <kind>        what to do with the selection
//                          (id|path|cwd|both|resume|copy)
//   --dump                 print the TSV fed to fzf, then exit
//   --version              print version
//   -h, --help             show help
//
// Unknown flags pass through to fzf. FZF_DEFAULT_OPTS is respected.
//
// Self-dispatches: `ccresume preview <sessionId> <jsonlPath> <query>` is
// invoked by fzf for the preview pane; `ccresume toggle-mode` flips
// preview filter/full mode. Internal — don't invoke directly.

import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { argv, exit, platform, stdout } from 'node:process'
import { parseArgs as nodeParseArgs } from 'node:util'

export const VERSION = '0.2.0'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const PARSE_CONCURRENCY = 32
const MAX_SEARCH_BODY = 200_000
const PREVIEW_MAX_BODY = 500_000

const userArgs = argv.slice(2)
// Compiled binary mode: Bun's --compile substitutes argv[1] with a
// /$bunfs/ virtual-fs path but keeps the offset; user args still start
// at argv[2]. process.execPath is the real installed binary path.
const isCompiledBinary = argv[1]?.startsWith('/$bunfs/') ?? false
const SELF_INVOCATION = isCompiledBinary
  ? JSON.stringify(process.execPath)
  : `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(argv[1]!))}`

// ── cwd encoding ─────────────────────────────────────────────────────────────
// Matches Claude Code's src/utils/cachePaths.ts sanitizePath(): every
// non-alphanumeric byte → '-'. Brittle link; tests/ has fixtures to
// catch drift.
export function encodeCwd(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

// ── JSONL parsing ────────────────────────────────────────────────────────────
export type Entry = { type?: string; [k: string]: unknown }

// Reads the file once and returns parsed lines. The previous "iter" API
// was misleading — it always read the whole buffer up front. Returning
// the array lets callers iterate multiple times without re-reading.
export async function readAllEntries(path: string): Promise<Entry[]> {
  const buf = await readFile(path, 'utf8')
  const out: Entry[] = []
  let start = buf.charCodeAt(0) === 0xfeff ? 1 : 0
  while (start < buf.length) {
    let end = buf.indexOf('\n', start)
    if (end === -1) end = buf.length
    const line = buf.slice(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      out.push(JSON.parse(line) as Entry)
    } catch {
      // skip malformed line
    }
  }
  return out
}

// XML-like <tag>…</tag>. Lowercase-only so JSX/HTML in user prose
// ("fix the <Button>", "<!DOCTYPE html>") passes through. Non-greedy
// with backref close-tag.
const XML_TAG_BLOCK_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

// Strip display tags. If `allowEmpty=false` (default), returns the
// original on a fully-tagged input (better to show something than
// blank). If `allowEmpty=true`, returns '' — used to detect "this
// message is just a slash-command wrapper, skip it".
export function stripDisplayTags(text: string, allowEmpty = false): string {
  const result = text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
  if (result) return result
  return allowEmpty ? '' : text
}

function extractMessageText(entry: Entry): string {
  const msg = entry.message
  if (!msg || typeof msg !== 'object') return ''
  const c = (msg as Record<string, unknown>).content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map(b => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (typeof o.text === 'string') return o.text
          if (o.type === 'thinking' && typeof o.thinking === 'string') return o.thinking
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

// ── session → row ────────────────────────────────────────────────────────────
export type SessionRow = {
  sessionId: string
  path: string
  mtime: number
  created: number
  size: number
  title: string
  branch: string
  cwd: string
  tag: string
  summary: string
  firstPrompt: string
  customTitle: string
  agentName: string
  agentSetting: string
  teamName: string
  messageCount: number
  isSidechain: boolean
  isAutonomous: boolean
  prNumber: number
  prUrl: string
  prRepository: string
  body: string
}

export function buildRow(entries: Entry[], path: string, st: Pick<Stats, 'mtimeMs' | 'birthtimeMs' | 'size'>, includeBody: boolean): SessionRow {
  const sessionId = basename(path, '.jsonl')
  let branch = ''
  let cwd = ''
  let teamName = ''
  let agentSetting = ''
  let tag = ''
  let summary = ''
  let firstPromptRaw = ''
  let customTitle = ''
  let aiTitle = ''
  let agentName = ''
  let lastPrompt = ''
  let firstUserMsg = ''
  let messageCount = 0
  let isSidechain = false
  let body = ''
  let prNumber = 0
  let prUrl = ''
  let prRepository = ''

  for (const e of entries) {
    const t = e.type
    if (t === 'user' || t === 'assistant') {
      messageCount++
      if (e.isSidechain) isSidechain = true
      if (!firstUserMsg && t === 'user' && !e.isMeta && !e.isCompactSummary) {
        const txt = extractMessageText(e)
        if (txt) {
          // Mirror the resume picker's filter: messages whose entire
          // body is display-tag wrappers (e.g.
          // `<command-name>/foo</command-name>`) aren't real prompts.
          const stripped = stripDisplayTags(txt, true)
          if (stripped) {
            firstPromptRaw = txt
            // Source extractFirstPrompt: \n → space, cap at 200 with
            // ellipsis (sessionStorage.ts:1729).
            let s = stripped.replace(/\n/g, ' ').trim()
            if (s.length > 200) s = s.slice(0, 200).trim() + '…'
            firstUserMsg = s
          }
        }
      }
      if (typeof e.gitBranch === 'string' && !branch) branch = e.gitBranch
      if (typeof e.cwd === 'string' && !cwd) cwd = e.cwd
      if (typeof e.teamName === 'string' && !teamName) teamName = e.teamName
      if (includeBody && body.length < MAX_SEARCH_BODY) {
        const txt = extractMessageText(e)
        if (txt) body += ' ' + txt.replace(/\s+/g, ' ')
      }
    } else if (t === 'summary' && typeof e.summary === 'string') summary = e.summary
    else if (t === 'custom-title' && typeof e.customTitle === 'string') customTitle = e.customTitle
    else if (t === 'ai-title' && typeof e.aiTitle === 'string') aiTitle = e.aiTitle
    else if (t === 'tag' && typeof e.tag === 'string') tag = e.tag
    else if (t === 'last-prompt' && typeof e.lastPrompt === 'string') lastPrompt = e.lastPrompt
    else if (t === 'agent-name' && typeof e.agentName === 'string') agentName = e.agentName
    else if (t === 'agent-setting' && typeof e.agentSetting === 'string') agentSetting = e.agentSetting
    else if (t === 'pr-link') {
      // Last pr-link wins (mirrors source's currentSession* overwrite).
      if (typeof e.prNumber === 'number') prNumber = e.prNumber
      if (typeof e.prUrl === 'string') prUrl = e.prUrl
      if (typeof e.prRepository === 'string') prRepository = e.prRepository
    }
  }

  const firstPrompt = lastPrompt || firstUserMsg || ''
  // Autonomous sessions start with <tick>...</tick> auto-prompts
  // (TICK_TAG in src/constants/xml.ts). Source: log.ts:35.
  const isAutonomous =
    firstPromptRaw.startsWith('<tick>') || lastPrompt.startsWith('<tick>')

  let title =
    agentName ||
    customTitle ||
    aiTitle ||
    summary ||
    firstPrompt ||
    (isAutonomous ? 'Autonomous session' : '') ||
    sessionId.slice(0, 8)
  title = stripDisplayTags(title).replace(/\s+/g, ' ').trim()

  if (body.length > MAX_SEARCH_BODY) body = body.slice(0, MAX_SEARCH_BODY)

  return {
    sessionId,
    path,
    mtime: st.mtimeMs,
    created: st.birthtimeMs,
    size: st.size,
    title,
    branch,
    cwd,
    tag,
    summary,
    firstPrompt,
    customTitle,
    agentName,
    agentSetting,
    teamName,
    messageCount,
    isSidechain,
    isAutonomous,
    prNumber,
    prUrl,
    prRepository,
    body,
  }
}

async function parseSession(path: string, includeBody: boolean): Promise<SessionRow | null> {
  try {
    const [st, entries] = await Promise.all([stat(path), readAllEntries(path)])
    return buildRow(entries, path, st, includeBody)
  } catch {
    return null
  }
}

export function shortenCwd(cwd: string): string {
  if (!cwd) return ''
  const home = homedir()
  return cwd.startsWith(home + '/') || cwd === home ? '~' + cwd.slice(home.length) : cwd
}

async function listProjectDirs(rootCwd: string | null): Promise<string[]> {
  if (rootCwd) {
    const dir = join(PROJECTS_ROOT, encodeCwd(rootCwd))
    try {
      await stat(dir)
      return [dir]
    } catch {
      return []
    }
  }
  const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true })
  return entries.filter(d => d.isDirectory()).map(d => join(PROJECTS_ROOT, d.name))
}

async function collectSessionFiles(projectDirs: string[]): Promise<string[]> {
  const out: string[] = []
  await Promise.all(
    projectDirs.map(async dir => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
        const id = basename(e.name, '.jsonl')
        if (!UUID_RE.test(id)) continue
        out.push(join(dir, e.name))
      }
    }),
  )
  return out
}

// Bounded-concurrency map. Without this, --all on a user with hundreds
// of session files would open hundreds of fds at once (macOS default
// ulimit is 256).
async function pMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

// ── formatting ───────────────────────────────────────────────────────────────
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function formatAge(mtime: number): string {
  const sec = Math.max(0, (Date.now() - mtime) / 1000)
  if (sec < 60) return `${sec | 0}s`
  if (sec < 3600) return `${(sec / 60) | 0}m`
  if (sec < 86400) return `${(sec / 3600) | 0}h`
  return `${(sec / 86400) | 0}d`
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const GREEN = '\x1b[32m'
const MAGENTA = '\x1b[35m'
const HL = '\x1b[1;30;43m' // black on yellow

// ── clipboard (cross-platform) ───────────────────────────────────────────────
// Returns argv to pipe stdin to the system clipboard, or null if no
// backend is installed. Picks the first available on the platform.
export function findClipboardArgv(): string[] | null {
  const candidates: string[][] =
    platform === 'darwin'
      ? [['pbcopy']]
      : platform === 'win32'
        ? [['clip']]
        : [
            ['wl-copy'],
            ['xclip', '-selection', 'clipboard'],
            ['xsel', '--clipboard', '--input'],
          ]
  for (const c of candidates) {
    if (Bun.which(c[0]!)) return c
  }
  return null
}

function clipboardShellPipeline(): string | null {
  const argv = findClipboardArgv()
  if (!argv) return null
  return argv.map(a => JSON.stringify(a)).join(' ')
}

// ── arg parsing ──────────────────────────────────────────────────────────────
type Args = {
  cwd: string | null
  all: boolean
  includeBody: boolean
  action: 'id' | 'path' | 'cwd' | 'both' | 'resume' | 'copy'
  query: string
  dump: boolean
  fzfPassthrough: string[]
}

const VALID_ACTIONS = ['id', 'path', 'cwd', 'both', 'resume', 'copy'] as const

// Our flags. Anything else with a leading '-' is forwarded to fzf
// verbatim. Bare positionals become the query.
const OWN_BOOL_FLAGS = new Set(['--all', '--no-transcript', '--dump'])
const OWN_VALUE_FLAGS = new Set(['--cwd', '--action'])

function die(msg: string): never {
  console.error(`ccresume: ${msg}`)
  console.error(`(try --help)`)
  exit(2)
}

function parseArgs(rest: string[]): Args {
  const own: string[] = []
  const fzfPassthrough: string[] = []
  const positionals: string[] = []
  let i = 0
  let sawDashDash = false
  while (i < rest.length) {
    const tok = rest[i]!
    if (sawDashDash) {
      fzfPassthrough.push(tok)
      i++
      continue
    }
    if (tok === '--') {
      sawDashDash = true
      i++
      continue
    }
    if (tok === '-h' || tok === '--help') {
      printHelp()
      exit(0)
    }
    if (tok === '--version') {
      console.log(`ccresume ${VERSION}`)
      exit(0)
    }
    const eq = tok.indexOf('=')
    const keyPart = eq >= 0 ? tok.slice(0, eq) : tok
    if (OWN_BOOL_FLAGS.has(keyPart) && eq < 0) {
      own.push(tok)
      i++
      continue
    }
    if (OWN_VALUE_FLAGS.has(keyPart)) {
      if (eq >= 0) {
        own.push(tok)
        i++
      } else {
        const v = rest[i + 1]
        if (v === undefined) die(`${tok} requires a value`)
        own.push(tok, v)
        i += 2
      }
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      // Unknown flag → fzf. Value-bearing fzf flags must use `--k=v`
      // form (or sit after `--`), since we can't tell value flags from
      // boolean ones without an exhaustive list.
      fzfPassthrough.push(tok)
      i++
      continue
    }
    positionals.push(tok)
    i++
  }

  let ownValues: Record<string, string | boolean | undefined>
  try {
    const result = nodeParseArgs({
      args: own,
      options: {
        all: { type: 'boolean' },
        cwd: { type: 'string' },
        'no-transcript': { type: 'boolean' },
        action: { type: 'string' },
        dump: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    })
    ownValues = result.values as Record<string, string | boolean | undefined>
  } catch (e) {
    die((e as Error).message)
  }

  let action: Args['action'] | null = null
  if (typeof ownValues.action === 'string') {
    if (!(VALID_ACTIONS as readonly string[]).includes(ownValues.action)) {
      die(`--action must be one of: ${VALID_ACTIONS.join(', ')} (got: '${ownValues.action}')`)
    }
    action = ownValues.action as Args['action']
  }

  const all = ownValues.all === true
  const cwd: string | null = all
    ? null
    : typeof ownValues.cwd === 'string'
      ? resolve(ownValues.cwd)
      : process.cwd()

  // Default: just resume — the resume action already cds into the
  // session's cwd before exec, so --all and single-cwd both work. Users
  // who want raw output for shell composition can pass --action id|both.
  if (action === null) action = 'resume'

  return {
    cwd,
    all,
    includeBody: ownValues['no-transcript'] !== true,
    action,
    query: positionals.join(' '),
    dump: ownValues.dump === true,
    fzfPassthrough,
  }
}

function printHelp() {
  const noClip = clipboardShellPipeline() ? '' : `\n  (no clipboard backend found; install pbcopy/wl-copy/xclip/xsel for ctrl-y)`
  console.log(`ccresume ${VERSION} — fzf picker for Claude Code sessions

Usage:
  ccresume [options] [query] [-- ...fzf args]

ccresume options:
  --all                  search every project on disk
  --cwd <path>           specific project cwd (default: $PWD)
  --no-transcript        skip transcript-body indexing (faster, metadata only)
  --action <kind>        what to do with the selection (default: 'resume')
                         kinds: resume | id | path | cwd | both | copy
                                resume → cd to cwd, exec claude --resume
                                both   → "<cwd><TAB><id>"
  --dump                 print the TSV fed to fzf, then exit
  --version              print version
  -h, --help             show this help

Pass-through to fzf:
  Any unknown flag is forwarded to fzf verbatim. fzf options that take
  a value must use --flag=value form (or sit after \`--\`), because
  ccresume can't tell unfamiliar value flags from boolean ones.

  Examples:
    ccresume --preview-window=down:70%:wrap
    ccresume --height=80% --layout=default
    ccresume --bind=ctrl-r:reload(echo)
    ccresume --exact                      # exact-match only
    ccresume --algo=v1                    # faster, less smart matching
    ccresume --no-mouse                   # disable mouse
    ccresume "query" -- --color=bw        # everything after -- is fzf

fzf env vars are respected unchanged:
  FZF_DEFAULT_OPTS       applied as usual
  FZF_DEFAULT_COMMAND    unused (we provide our own stdin)

Default bindings (override with --bind=key:action):
  enter    select          ctrl-/   flip preview position
  ctrl-y   copy id         alt-t    toggle preview: filtered ↔ full
  esc      abort${noClip}

Search syntax (fzf default):
  foo bar      AND match             !word         must not contain
  'exact       exact substring       ^prefix       prefix match
  suffix$      suffix match          a | b         OR within a token

Preview scroll:
  mousewheel        scroll preview (default; terminal-dependent)
  shift-↑ / ↓       one line
  PgUp / PgDn       one screen

Shell composition (use --action to get raw output instead of resuming):
  claude --resume "$(ccresume --action id)"             # print id only
  read cwd id <<< "$(ccresume --all --action both)"     # cd "$cwd" && claude --resume "$id"

Note: don't pass \`-q\` to ccresume; bare positionals are the query.

Internal subcommands (used by fzf bindings, do not invoke directly):
  ccresume preview <sessionId> <path> <query>
  ccresume toggle-mode`)
}

// ── launcher ─────────────────────────────────────────────────────────────────
async function runLauncher(args: Args) {
  const projectDirs = await listProjectDirs(args.cwd)
  if (projectDirs.length === 0) {
    console.error(`no sessions found for ${args.cwd ?? 'any cwd'}`)
    exit(1)
  }
  const files = await collectSessionFiles(projectDirs)
  if (files.length === 0) {
    console.error('no .jsonl sessions in project dir(s)')
    exit(1)
  }

  // Filter rules mirror Claude Code's enrichLog
  // (src/utils/sessionStorage.ts:5055-5067): drop sidechains (subagent
  // transcripts), team-spawned sessions, and empty shells.
  const parsed = await pMap(files, PARSE_CONCURRENCY, f =>
    parseSession(f, args.includeBody).catch(() => null),
  )
  const rows = parsed
    .filter((r): r is SessionRow => {
      if (!r) return false
      if (r.isSidechain) return false
      if (r.teamName) return false
      if (!r.firstPrompt && !r.customTitle) return false
      return true
    })
    // Source sortLogs (types/logs.ts:319): mtime DESC, tiebreak created
    // DESC — without it two sessions saved at the same minute flip
    // order between runs.
    .sort((a, b) => b.mtime - a.mtime || b.created - a.created)

  // ── TSV for fzf ─────────────────────────────────────────────────────────
  // fzf 0.70: once --with-nth is set, --nth indexes the *transformed*
  // line, so "show col-A but search col-A+col-B in separate columns"
  // doesn't work. Merge display + haystack into one column; sessionId,
  // path, cwd ride in trailing fields surfaced via --accept-nth.
  const tsv = rows
    .map(r => {
      const cwdShort = args.all && r.cwd ? shortenCwd(r.cwd) : ''
      const prLabel = r.prNumber ? `PR #${r.prNumber}` : ''
      const display = [
        BOLD + clip(r.title || '(untitled)', 80) + RESET,
        DIM + formatAge(r.mtime).padStart(4) + ' ago' + RESET,
        CYAN + clip(r.branch || '-', 36) + RESET,
        cwdShort ? MAGENTA + clip(cwdShort, 36) + RESET : '',
        r.tag ? YELLOW + '#' + r.tag + RESET : '',
        prLabel ? GREEN + prLabel + RESET : '',
        DIM + formatBytes(r.size) + RESET,
        DIM + r.messageCount + 'msg' + RESET,
      ]
        .filter(Boolean)
        .join('  ')

      const prInfo = r.prNumber ? `pr #${r.prNumber} ${r.prRepository}` : ''
      const haystack = [
        r.customTitle,
        r.agentName,
        r.agentSetting,
        r.summary,
        r.firstPrompt,
        r.cwd,
        prInfo,
        r.body,
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/[\t\r\n]/g, ' ')

      const merged = haystack ? `${display}  ${DIM}│  ${haystack}${RESET}` : display
      return [merged, r.sessionId, r.path, r.cwd].join('\t')
    })
    .join('\n')

  if (args.dump) {
    stdout.write(tsv + '\n')
    return
  }

  // Per-invocation state file in tmpdir keeps concurrent pickers from
  // fighting over the same alt-t mode. /tmp is auto-cleaned by the OS;
  // we still unlink on exit for tidiness.
  const sessionToken = Math.random().toString(36).slice(2, 10)
  const stateFile = join(tmpdir(), `ccresume-${sessionToken}`)

  const previewCmd = `${SELF_INVOCATION} preview {2} {3} {q}`
  const toggleCmd = `${SELF_INVOCATION} toggle-mode`

  // Defaults appear BEFORE pass-through so user flags win (fzf is
  // last-wins for most flags).
  const defaultFzfArgs: string[] = [
    '--ansi',
    '--delimiter=\t',
    '--with-nth=1',
    '--nth=1',
    '--accept-nth=2,3,4',
    // begin: prefer matches closer to the start of the haystack, which
    // floats title hits above body hits (title sits at column 0). index
    // tiebreak after that keeps mtime DESC for everything else.
    '--tiebreak=begin,index',
    // Keep title anchored at col 0; otherwise deep haystack matches
    // scroll the title off-screen.
    '--no-hscroll',
    '--height=100%',
    '--layout=reverse',
    '--info=inline',
    '--prompt=session> ',
    '--preview', previewCmd,
    '--preview-window', 'right:60%:wrap',
    '--bind=ctrl-/:change-preview-window(down,50%,wrap|hidden|right,60%,wrap)',
    `--bind=alt-t:execute-silent(${toggleCmd})+refresh-preview`,
    '--header',
    `${rows.length} sessions · ctrl-y copy · ctrl-/ flip preview · alt-t toggle full/filtered`,
  ]

  const copyPipeline = clipboardShellPipeline()
  if (copyPipeline) {
    defaultFzfArgs.push(`--bind=ctrl-y:execute-silent(printf %s {2} | ${copyPipeline})+abort`)
  }

  const fzfArgs = [...defaultFzfArgs, ...args.fzfPassthrough]
  if (args.query) fzfArgs.push('-q', args.query)

  // We don't touch FZF_DEFAULT_OPTS — user's dotfile defaults apply.
  const env = { ...process.env, CCRESUME_STATE_FILE: stateFile }

  try {
    const fzf = Bun.spawn(['fzf', ...fzfArgs], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env,
    })
    fzf.stdin.write(tsv)
    await fzf.stdin.end()

    const out = await new Response(fzf.stdout).text()
    const code = await fzf.exited
    if (code !== 0 || !out.trim()) exit(code)

    const [sessionId, path, sessionCwd = ''] = out.trim().split('\t')
    if (!sessionId) exit(1)

    switch (args.action) {
      case 'id':
        stdout.write(sessionId + '\n')
        break
      case 'path':
        stdout.write(path + '\n')
        break
      case 'cwd':
        stdout.write(sessionCwd + '\n')
        break
      case 'both':
        stdout.write(`${sessionCwd}\t${sessionId}\n`)
        break
      case 'copy': {
        const cmd = findClipboardArgv()
        if (!cmd) die('no clipboard backend (install pbcopy/wl-copy/xclip/xsel)')
        Bun.spawn(cmd, { stdin: new Response(sessionId).body! })
        console.error(`copied: ${sessionId}`)
        break
      }
      case 'resume':
        // cd into the session's project before launching claude —
        // sessions are scoped to cwd, so resuming from the wrong dir
        // creates a new empty session.
        Bun.spawnSync(['claude', '--resume', sessionId!], {
          cwd: sessionCwd || undefined,
          stdio: ['inherit', 'inherit', 'inherit'],
        })
        break
    }
  } finally {
    try {
      await unlink(stateFile)
    } catch {}
  }
}

// ── preview ──────────────────────────────────────────────────────────────────
export function tokenize(q: string): string[] {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/^['"]|['"]$/g, '').replace(/^[!^]/, ''))
    .filter(t => t.length > 0)
}

export function highlight(text: string, tokens: string[]): string {
  if (tokens.length === 0) return text
  const re = new RegExp(
    '(' + tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
    'gi',
  )
  return text.replace(re, m => HL + m + RESET)
}

export function hasMatch(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const lower = text.toLowerCase()
  return tokens.every(t => lower.includes(t.toLowerCase()))
}

type PreviewMode = 'filter' | 'full'

function stateFilePath(): string {
  // Set by the launcher per-invocation. Fall back to a global path if
  // someone runs the preview subcommand directly (which they
  // shouldn't, but we don't want to crash).
  return process.env.CCRESUME_STATE_FILE || join(homedir(), '.cache', 'ccresume', 'preview-mode')
}

async function readPreviewMode(): Promise<PreviewMode> {
  try {
    const v = (await Bun.file(stateFilePath()).text()).trim()
    return v === 'full' ? 'full' : 'filter'
  } catch {
    return 'filter'
  }
}

async function runToggleMode() {
  const f = stateFilePath()
  await mkdir(dirname(f), { recursive: true })
  await Bun.write(f, (await readPreviewMode()) === 'filter' ? 'full' : 'filter')
}

async function runPreview(sessionId: string, path: string, query: string) {
  // fzf passes empty {1}/{2} when no row is focused (e.g. 0 matches).
  if (!sessionId || !path) {
    console.log(DIM + '(no session selected — refine your query)' + RESET)
    return
  }
  const tokens = tokenize(query)
  const mode = await readPreviewMode()

  // Single read: stats + entries once, shared between row building,
  // transcript rendering, and footer counts.
  let st: Stats
  let entries: Entry[]
  try {
    ;[st, entries] = await Promise.all([stat(path), readAllEntries(path)])
  } catch (e) {
    console.log(DIM + `(can't read ${path}: ${(e as Error).message})` + RESET)
    return
  }
  const row = buildRow(entries, path, st, true)

  const modeLabel =
    mode === 'full'
      ? `${DIM}[mode:${RESET} ${YELLOW}full${RESET}${DIM} · alt-t for filtered]${RESET}`
      : `${DIM}[mode:${RESET} ${GREEN}filtered${RESET}${DIM} · alt-t for full]${RESET}`

  const titleLine =
    BOLD + (row.title || '(untitled)') + RESET +
    (row.isAutonomous ? '  ' + DIM + '(autonomous)' + RESET : '') +
    '  ' + modeLabel
  const prLine = row.prNumber
    ? `${DIM}pr:${RESET}     ${GREEN}#${row.prNumber}${RESET}` +
      (row.prRepository ? ` ${DIM}${row.prRepository}${RESET}` : '') +
      (row.prUrl ? `  ${DIM}${row.prUrl}${RESET}` : '')
    : ''
  const header = [
    titleLine,
    `${DIM}id:${RESET}     ${sessionId}`,
    row.cwd ? `${DIM}cwd:${RESET}    ${MAGENTA}${shortenCwd(row.cwd)}${RESET}` : '',
    `${DIM}branch:${RESET} ${CYAN}${row.branch || '-'}${RESET}`,
    row.tag ? `${DIM}tag:${RESET}    ${YELLOW}#${row.tag}${RESET}` : '',
    prLine,
    row.agentSetting ? `${DIM}agent:${RESET}  ${row.agentSetting}` : '',
    row.customTitle ? `${DIM}custom:${RESET} ${row.customTitle}` : '',
    row.summary ? `${DIM}sum:${RESET}    ${clip(row.summary, 200)}` : '',
    `${DIM}meta:${RESET}   ${row.messageCount}msg · ${formatBytes(row.size)} · ${formatAge(row.mtime)} ago`,
  ]
    .filter(Boolean)
    .map(s => highlight(s, tokens))
    .join('\n')

  console.log(header)
  console.log(DIM + '─'.repeat(60) + RESET)

  const showAll = mode === 'full' || tokens.length === 0
  let bytes = 0
  let printed = 0
  let scanned = 0
  let matched = 0

  for (const e of entries) {
    if (e.type !== 'user' && e.type !== 'assistant') continue
    scanned++
    const txt = extractMessageText(e)
    if (!txt) continue
    const isMatch = tokens.length > 0 && hasMatch(txt, tokens)
    if (isMatch) matched++

    let body: string
    if (showAll) {
      const clipped = txt.length > 4000 ? txt.slice(0, 4000) + DIM + '…' + RESET : txt
      body = highlight(clipped, tokens)
    } else {
      if (!isMatch) continue
      body = highlight(snippetAroundMatches(txt, tokens), tokens)
    }

    printed++
    bytes += body.length
    const role = e.type === 'user' ? GREEN + '▸ user' + RESET : CYAN + '▸ asst' + RESET
    const ts = typeof e.timestamp === 'string'
      ? DIM + ' ' + new Date(e.timestamp).toISOString().slice(11, 19) + RESET
      : ''
    console.log(`\n${role}${ts}`)
    console.log(body)

    if (bytes > PREVIEW_MAX_BODY) {
      console.log(DIM + `\n…truncated (>${formatBytes(PREVIEW_MAX_BODY)})` + RESET)
      break
    }
  }

  if (tokens.length > 0) {
    if (showAll) {
      console.log(DIM + `\n${matched} of ${printed} messages contain query` + RESET)
    } else if (printed === 0) {
      console.log(DIM + `\nno message body matches "${query}" (matched on metadata)` + RESET)
      console.log(DIM + `press alt-t to view full transcript` + RESET)
    } else {
      console.log(DIM + `\n${printed}/${scanned} messages matched · alt-t for full` + RESET)
    }
  }
}

export function snippetAroundMatches(text: string, tokens: string[], contextChars = 200): string {
  if (tokens.length === 0) return text.slice(0, contextChars * 2)
  const lower = text.toLowerCase()
  const segments: Array<[number, number]> = []
  for (const t of tokens) {
    const needle = t.toLowerCase()
    let from = 0
    while (true) {
      const i = lower.indexOf(needle, from)
      if (i === -1) break
      segments.push([Math.max(0, i - contextChars), Math.min(text.length, i + needle.length + contextChars)])
      from = i + needle.length
    }
  }
  if (segments.length === 0) return text.slice(0, contextChars * 2)
  segments.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [segments[0]!]
  for (let i = 1; i < segments.length; i++) {
    const last = merged[merged.length - 1]!
    const cur = segments[i]!
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1])
    else merged.push(cur)
  }
  return merged
    .map(([a, b], idx) => {
      const pre = a > 0 && idx === 0 ? DIM + '…' + RESET : ''
      const post = b < text.length ? DIM + '…' + RESET : ''
      return pre + text.slice(a, b) + post
    })
    .join(DIM + '\n  ⋯\n' + RESET)
}

// ── entrypoint ───────────────────────────────────────────────────────────────
if (import.meta.main) {
  const sub = userArgs[0]
  if (sub === 'preview') {
    const [, sessionId, path, ...queryParts] = userArgs
    await runPreview(sessionId!, path!, queryParts.join(' '))
  } else if (sub === 'toggle-mode') {
    await runToggleMode()
  } else {
    await runLauncher(parseArgs(userArgs))
  }
}

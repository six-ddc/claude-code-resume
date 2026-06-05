#!/usr/bin/env bun
// ccresume (claude-code-resume) — fzf-style picker for Claude Code sessions
//
// ccresume options:
//   --no-transcript        skip transcript-body indexing (faster, metadata only)
//   --action <kind>        what to do with the selection
//                          (id|path|cwd|both|resume|copy)
//   --dump                 print the tree TSV fed to fzf, then exit
//   --version              print version
//   -h, --help             show help
//
// Unknown flags pass through to fzf. FZF_DEFAULT_OPTS is respected.
//
// Self-dispatches into internal subcommands for fzf reload, tree enter,
// preview rendering, preview layout, clipboard copy, and preview mode
// toggling. Internal — don't invoke directly.

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
const TREE_STATE_VERSION = 1
const DEFAULT_DIR_LIMIT = 10
const DIR_LIMIT_STEP = 10
const PREVIEW_RIGHT = 'right,60%,wrap'
const PREVIEW_DOWN = 'down,67%,wrap'

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
  lastActivity: number
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
  let lastTs = 0

  for (const e of entries) {
    const t = e.type
    // Track the newest entry timestamp (any type) for sort + age display.
    // Lines are append-ordered, but taking the max also shrugs off the
    // occasional out-of-order sidechain/agent entry.
    if (typeof e.timestamp === 'string') {
      const ts = Date.parse(e.timestamp)
      if (!Number.isNaN(ts) && ts > lastTs) lastTs = ts
    }
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
    // Newest message timestamp; fall back to file mtime for sessions
    // whose entries carry no parseable timestamp.
    lastActivity: lastTs || st.mtimeMs,
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

// Bounded-concurrency map. Without this, users with hundreds of session
// files would open hundreds of fds at once (macOS default ulimit is 256).
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

// ── tree picker state/rendering ──────────────────────────────────────────────
type TreeState = {
  version: typeof TREE_STATE_VERSION
  rows: SessionRow[]
  searchFile: string
  dirLimits: Record<string, number>
  collapsedDirs: Record<string, boolean>
  searchFzfArgs: string[]
  currentBranches: Record<string, string>
}

type TreeItemType = 'dir' | 'session' | 'more'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function tsvField(s: string): string {
  return s.replace(/[\t\r\n]/g, ' ')
}

function renderTreeCommand(stateFile: string): string {
  return `${SELF_INVOCATION} render-tree ${shellQuote(stateFile)}`
}

function extractSearchFzfArgs(fzfArgs: string[]): string[] {
  const out: string[] = []
  for (const arg of fzfArgs) {
    if (
      arg === '-e' ||
      arg === '--exact' ||
      arg === '+x' ||
      arg === '--no-extended' ||
      arg === '-i' ||
      arg === '--ignore-case' ||
      arg === '+i' ||
      arg === '--no-ignore-case' ||
      arg === '--smart-case' ||
      arg === '--literal' ||
      arg === '+s' ||
      arg === '--no-sort' ||
      arg.startsWith('--algo=') ||
      arg.startsWith('--scheme=') ||
      arg.startsWith('--tiebreak=')
    ) {
      out.push(arg)
    }
  }
  return out
}

function hasFzfOption(fzfArgs: string[], opt: string): boolean {
  return fzfArgs.some(arg => arg === opt || arg.startsWith(opt + '='))
}

function sessionSearchText(r: SessionRow): string {
  const prInfo = r.prNumber ? `pr #${r.prNumber} ${r.prRepository} ${r.prUrl}` : ''
  return [
    r.title,
    r.customTitle,
    r.agentName,
    r.agentSetting,
    r.summary,
    r.firstPrompt,
    r.branch,
    r.cwd,
    r.tag ? `#${r.tag}` : '',
    r.sessionId,
    prInfo,
    r.body,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/[\t\r\n\0]/g, ' ')
}

async function fzfFilterRows(rows: SessionRow[], query: string, searchFzfArgs: string[], searchFile?: string): Promise<SessionRow[]> {
  const q = query.trim()
  if (!q) return rows
  if (rows.length === 0) return []

  const input = searchFile
    ? await Bun.file(searchFile).text()
    : rows.map(r => `${sessionSearchText(r)}\t${r.sessionId}`).join('\n')
  const fzf = Bun.spawn(
    [
      'fzf',
      '--filter',
      query,
      '--delimiter=\t',
      '--nth=1',
      '--accept-nth=2',
      ...searchFzfArgs,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FZF_DEFAULT_OPTS: '', FZF_DEFAULT_OPTS_FILE: '' },
    },
  )
  fzf.stdin.write(input)
  await fzf.stdin.end()
  const [out, err, code] = await Promise.all([
    new Response(fzf.stdout).text(),
    new Response(fzf.stderr).text(),
    fzf.exited,
  ])
  if (code !== 0 && code !== 1) {
    throw new Error(err.trim() || `fzf --filter exited ${code}`)
  }
  if (!out.trim()) return []

  const byId = new Map(rows.map(r => [r.sessionId, r] as const))
  return out
    .split('\n')
    .map(id => byId.get(id.trim()))
    .filter((r): r is SessionRow => Boolean(r))
}

type DirectoryGroup = {
  cwd: string
  rows: SessionRow[]
  lastActivity: number
}

function groupRowsByCwd(rows: SessionRow[]): DirectoryGroup[] {
  const map = new Map<string, SessionRow[]>()
  for (const r of rows) {
    const cwd = r.cwd || dirname(r.path)
    const group = map.get(cwd)
    if (group) group.push(r)
    else map.set(cwd, [r])
  }
  return [...map.entries()]
    .map(([cwd, groupRows]) => ({
      cwd,
      rows: groupRows,
      lastActivity: Math.max(...groupRows.map(r => r.lastActivity)),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity || shortenCwd(a.cwd).localeCompare(shortenCwd(b.cwd)))
}

async function currentGitBranch(cwd: string): Promise<string> {
  if (!cwd) return ''
  try {
    const git = Bun.spawn(['git', '-C', cwd, 'branch', '--show-current'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, , code] = await Promise.all([
      new Response(git.stdout).text(),
      new Response(git.stderr).text(),
      git.exited,
    ])
    if (code !== 0) return ''
    return out.trim().split('\n')[0]?.trim() || ''
  } catch {
    return ''
  }
}

async function currentBranchesByCwd(cwds: string[]): Promise<Record<string, string>> {
  const pairs = await pMap([...new Set(cwds)].filter(Boolean), PARSE_CONCURRENCY, async cwd => {
    return [cwd, await currentGitBranch(cwd)] as const
  })
  return Object.fromEntries(pairs.filter(([, branch]) => branch))
}

function treeTsvLine(
  display: string,
  type: TreeItemType,
  key: string,
  sessionId = '',
  path = '',
  cwd = '',
): string {
  return [display, type, key, sessionId, path, cwd].map(tsvField).join('\t')
}

function directoryDisplay(
  group: DirectoryGroup,
  shownCount: number,
  visibleCount: number,
  queryActive: boolean,
  currentBranch: string,
  collapsed: boolean,
): string {
  const total = group.rows.length
  const count = collapsed
    ? queryActive
      ? `${visibleCount} matches`
      : `${total} sessions`
    : queryActive
      ? `${shownCount}/${visibleCount} matches`
      : `${shownCount}/${total} shown`
  return [
    MAGENTA + (collapsed ? '▸ ' : '▾ ') + clip(shortenCwd(group.cwd), 96) + RESET,
    currentBranch ? CYAN + clip(currentBranch, 32) + RESET : '',
    DIM + count + RESET,
    DIM + 'last ' + formatAge(group.lastActivity) + ' ago' + RESET,
  ].filter(Boolean).join('  ')
}

function sessionDisplay(r: SessionRow, isLast: boolean, currentBranch: string): string {
  const prLabel = r.prNumber ? `PR #${r.prNumber}` : ''
  const branchLabel = r.branch && currentBranch && r.branch !== currentBranch ? r.branch : ''
  return [
    DIM + '  ' + (isLast ? '└─' : '├─') + RESET,
    clip(r.title || '(untitled)', 76),
    DIM + formatAge(r.lastActivity).padStart(4) + ' ago' + RESET,
    branchLabel ? CYAN + clip(branchLabel, 32) + RESET : '',
    r.tag ? YELLOW + '#' + r.tag + RESET : '',
    prLabel ? GREEN + prLabel + RESET : '',
    DIM + r.messageCount + 'msg' + RESET,
  ]
    .filter(Boolean)
    .join('  ')
}

async function readTreeState(stateFile: string): Promise<TreeState> {
  const state = JSON.parse(await Bun.file(stateFile).text()) as TreeState
  if (state.version !== TREE_STATE_VERSION || !Array.isArray(state.rows) || typeof state.searchFile !== 'string') {
    throw new Error('invalid tree state')
  }
  state.collapsedDirs ||= {}
  state.currentBranches ||= {}
  return state
}

async function writeTreeState(stateFile: string, state: TreeState): Promise<void> {
  await Bun.write(stateFile, JSON.stringify(state))
}

async function renderTreeTsv(state: TreeState, query: string): Promise<string> {
  const q = query.trim()
  const matchedRows = await fzfFilterRows(state.rows, q, state.searchFzfArgs, state.searchFile)
  if (matchedRows.length === 0) return ''

  const queryActive = q.length > 0
  const matchedByCwd = new Map<string, SessionRow[]>()
  const bestRankByCwd = new Map<string, number>()
  for (let rank = 0; rank < matchedRows.length; rank++) {
    const r = matchedRows[rank]!
    const cwd = r.cwd || dirname(r.path)
    const group = matchedByCwd.get(cwd)
    if (group) group.push(r)
    else matchedByCwd.set(cwd, [r])
    if (!bestRankByCwd.has(cwd)) bestRankByCwd.set(cwd, rank)
  }

  const allGroups = groupRowsByCwd(state.rows).sort((a, b) => {
    if (!queryActive) return 0
    return (bestRankByCwd.get(a.cwd) ?? Number.MAX_SAFE_INTEGER) - (bestRankByCwd.get(b.cwd) ?? Number.MAX_SAFE_INTEGER)
  })
  const lines: string[] = []
  for (const group of allGroups) {
    const visibleRows = matchedByCwd.get(group.cwd)
    if (!visibleRows || visibleRows.length === 0) continue

    const limit = Math.max(DEFAULT_DIR_LIMIT, state.dirLimits[group.cwd] || DEFAULT_DIR_LIMIT)
    const collapsed = state.collapsedDirs[group.cwd] === true
    const shownRows = collapsed ? [] : visibleRows.slice(0, limit)
    const currentBranch = state.currentBranches[group.cwd] || ''
    lines.push(treeTsvLine(directoryDisplay(group, shownRows.length, visibleRows.length, queryActive, currentBranch, collapsed), 'dir', group.cwd, '', '', group.cwd))

    if (collapsed) continue

    shownRows.forEach((r, idx) => {
      const hasMore = shownRows.length < visibleRows.length
      lines.push(treeTsvLine(sessionDisplay(r, !hasMore && idx === shownRows.length - 1, currentBranch), 'session', r.sessionId, r.sessionId, r.path, r.cwd))
    })
    if (shownRows.length < visibleRows.length) {
      const moreCount = Math.min(DIR_LIMIT_STEP, visibleRows.length - shownRows.length)
      const remaining = visibleRows.length - shownRows.length
      const display = [
        DIM + '  └─' + RESET,
        GREEN + `[+${moreCount}]` + RESET,
        `show ${moreCount} more`,
        DIM + `(${remaining} remaining)` + RESET,
      ].join('  ')
      lines.push(treeTsvLine(display, 'more', group.cwd, '', '', group.cwd))
    }
  }
  return lines.join('\n')
}

async function runRenderTree(stateFile: string) {
  const state = await readTreeState(stateFile)
  const tsv = await renderTreeTsv(state, process.env.FZF_QUERY || '')
  if (tsv) stdout.write(tsv + '\n')
}

async function runTreeEnter(stateFile: string, type: string, key: string) {
  if (type === 'session') {
    console.log('accept')
    return
  }

  if (type === 'dir') {
    const state = await readTreeState(stateFile)
    state.collapsedDirs ||= {}
    if (state.collapsedDirs[key]) delete state.collapsedDirs[key]
    else state.collapsedDirs[key] = true
    await writeTreeState(stateFile, state)
    console.log(`reload(${renderTreeCommand(stateFile)})+refresh-preview`)
    return
  }

  if (type !== 'more') {
    console.log('ignore')
    return
  }

  const state = await readTreeState(stateFile)
  state.dirLimits ||= {}
  state.dirLimits[key] = Math.max(DEFAULT_DIR_LIMIT, state.dirLimits[key] || DEFAULT_DIR_LIMIT) + DIR_LIMIT_STEP
  await writeTreeState(stateFile, state)
  console.log(`reload(${renderTreeCommand(stateFile)})+refresh-preview`)
}

async function runTreeCopy(type: string, sessionId: string) {
  if (type !== 'session' || !sessionId) {
    console.log('bell')
    return
  }
  const cmd = findClipboardArgv()
  if (!cmd) {
    console.log('change-header:no clipboard backend found')
    return
  }
  Bun.spawn(cmd, { stdin: new Response(sessionId).body! })
  console.log('abort')
}

async function runDirectoryPreview(stateFile: string, cwd: string, query: string) {
  const state = await readTreeState(stateFile)
  const rows = state.rows.filter(r => (r.cwd || dirname(r.path)) === cwd)
  const q = query.trim()
  const visibleRows = q
    ? (await fzfFilterRows(state.rows, q, state.searchFzfArgs, state.searchFile))
        .filter(r => (r.cwd || dirname(r.path)) === cwd)
    : rows
  const lastActivity = rows.length ? Math.max(...rows.map(r => r.lastActivity)) : 0

  console.log(BOLD + MAGENTA + shortenCwd(cwd) + RESET)
  console.log(
    `${DIM}type:${RESET}   directory  ${DIM}sessions:${RESET} ${q ? `${visibleRows.length}/${rows.length} matched` : rows.length}  ` +
      `${DIM}last:${RESET} ${lastActivity ? formatAge(lastActivity) + ' ago' : '-'}`,
  )
  if (q) {
    console.log(DIM + 'showing matching sessions in this directory' + RESET)
  }
  console.log(DIM + '─'.repeat(60) + RESET)

  if (rows.length === 0) {
    console.log(DIM + '(no sessions in this directory)' + RESET)
    return
  }
  if (visibleRows.length === 0) {
    console.log(DIM + '(no sessions in this directory match the query)' + RESET)
    return
  }

  for (const r of visibleRows.slice(0, 24)) {
    const parts = [
      DIM + formatAge(r.lastActivity).padStart(4) + ' ago' + RESET,
      CYAN + clip(r.branch || '-', 28) + RESET,
      BOLD + clip(r.title || '(untitled)', 90) + RESET,
      r.tag ? YELLOW + '#' + r.tag + RESET : '',
      DIM + r.messageCount + 'msg' + RESET,
    ].filter(Boolean)
    console.log(parts.join('  '))
  }
  if (visibleRows.length > 24) {
    console.log(DIM + `\n…${visibleRows.length - 24} more` + RESET)
  }
}

async function runPreviewItem(stateFile: string, type: string, key: string, sessionId: string, path: string) {
  const query = process.env.FZF_QUERY || ''
  if (type === 'dir') {
    await runDirectoryPreview(stateFile, key, query)
    return
  }
  if (type === 'more') {
    await runDirectoryPreview(stateFile, key, query)
    return
  }
  if (type === 'session') {
    await runPreview(sessionId, path, query)
    return
  }
  console.log(DIM + '(no item selected)' + RESET)
}

function autoPreviewWindow(cols: number, lines: number): string {
  if (!Number.isFinite(cols) || !Number.isFinite(lines) || cols <= 0 || lines <= 0) {
    return PREVIEW_RIGHT
  }

  const previewCols = Math.floor(cols * 0.6)
  const listCols = cols - previewCols
  const cellRatio = cols / Math.max(1, lines)
  return listCols >= 44 && previewCols >= 60 && cellRatio >= 2.5
    ? PREVIEW_RIGHT
    : PREVIEW_DOWN
}

async function runPreviewLayout() {
  const cols = Number(process.env.FZF_COLUMNS || process.env.COLUMNS || 0)
  const lines = Number(process.env.FZF_LINES || process.env.LINES || 0)
  console.log(`change-preview-window(${autoPreviewWindow(cols, lines)})`)
}

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

export function findBatArgv(): string[] | null {
  for (const name of ['bat', 'batcat']) {
    if (Bun.which(name)) return [name]
  }
  return null
}

async function writeMarkdownPreview(text: string) {
  const bat = findBatArgv()
  if (!bat) {
    stdout.write(text.endsWith('\n') ? text : text + '\n')
    return
  }

  try {
    const p = Bun.spawn(
      [
        ...bat,
        '--language=markdown',
        '--style=plain',
        '--color=always',
        '--paging=never',
        '--wrap=never',
        '--theme=ansi',
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, BAT_PAGER: 'cat' },
      },
    )
    p.stdin.write(text)
    await p.stdin.end()
    const [out, , code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    if (code === 0 && out) {
      stdout.write(out)
      return
    }
  } catch {}

  stdout.write(text.endsWith('\n') ? text : text + '\n')
}

// ── arg parsing ──────────────────────────────────────────────────────────────
type Args = {
  includeBody: boolean
  action: 'id' | 'path' | 'cwd' | 'both' | 'resume' | 'copy'
  query: string
  dump: boolean
  fzfPassthrough: string[]
}

const VALID_ACTIONS = ['id', 'path', 'cwd', 'both', 'resume', 'copy'] as const

// Our flags. Anything else with a leading '-' is forwarded to fzf
// verbatim. Bare positionals become the query.
const OWN_BOOL_FLAGS = new Set(['--no-transcript', '--dump'])
const OWN_VALUE_FLAGS = new Set(['--action'])

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
    if ((tok.startsWith('-') || tok.startsWith('+')) && tok.length > 1) {
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

  // Default: just resume — the resume action already cds into the
  // session's cwd before exec. Users who want raw output for shell
  // composition can pass --action id|both.
  if (action === null) action = 'resume'

  return {
    includeBody: ownValues['no-transcript'] !== true,
    action,
    query: positionals.join(' '),
    dump: ownValues.dump === true,
    fzfPassthrough,
  }
}

function printHelp() {
  const noClip = clipboardShellPipeline() ? '' : `\n  (no clipboard backend found; install pbcopy/wl-copy/xclip/xsel for ctrl-y)`
  console.log(`ccresume ${VERSION} — fzf tree picker for Claude Code sessions

Usage:
  ccresume [options] [query] [-- ...fzf args]

ccresume options:
  --no-transcript        skip transcript-body indexing (faster, metadata only)
  --action <kind>        what to do with the selection (default: 'resume')
                         kinds: resume | id | path | cwd | both | copy
                                resume → cd to cwd, exec claude --resume
                                both   → "<cwd><TAB><id>"
  --dump                 print the tree TSV fed to fzf, then exit
  --version              print version
  -h, --help             show this help

Pass-through to fzf:
  Any unknown flag is forwarded to fzf verbatim. fzf options that take
  a value must use --flag=value form (or sit after \`--\`), because
  ccresume can't tell unfamiliar value flags from boolean ones.
  The preview layout is auto-selected from terminal width/height unless
  you pass --preview-window explicitly.

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
  enter    dir toggle/more +10/select double-click dir toggle/more +10/select
  ctrl-y   copy id         ctrl-/       flip preview position
  alt-t    toggle preview: filtered ↔ full
  esc      abort${noClip}

Search syntax (fzf default):
  foo bar      AND match             !word         must not contain
  'exact       exact substring       ^prefix       prefix match
  suffix$      suffix match          a | b         OR within a token

Preview scroll:
  mousewheel        scroll preview (default; terminal-dependent)
  shift-↑ / ↓       one line
  PgUp / PgDn       one screen

Session preview:
  uses bat/batcat for Markdown rendering when installed

Shell composition (use --action to get raw output instead of resuming):
  claude --resume "$(ccresume --action id)"             # print id only
  read cwd id <<< "$(ccresume --action both)"           # cd "$cwd" && claude --resume "$id"

Note: don't pass \`-q\` to ccresume; bare positionals are the query.

Internal subcommands (used by fzf bindings, do not invoke directly):
  ccresume preview-item <stateFile> <type> <key> <sessionId> <path>
  ccresume preview-layout
  ccresume render-tree <stateFile>
  ccresume tree-enter <stateFile> <type> <key>
  ccresume tree-copy <type> <sessionId>
  ccresume toggle-mode`)
}

// ── launcher ─────────────────────────────────────────────────────────────────
async function runLauncher(args: Args) {
  const projectDirs = await listProjectDirs(null)
  if (projectDirs.length === 0) {
    console.error('no sessions found')
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
    // Last activity (newest message timestamp) DESC, tiebreak file
    // birthtime DESC — without the tiebreak two sessions whose last
    // message lands in the same minute flip order between runs.
    .sort((a, b) => b.lastActivity - a.lastActivity || b.created - a.created)

  // Per-invocation state file in tmpdir keeps concurrent pickers from
  // fighting over the same mode/tree state. /tmp is auto-cleaned by
  // the OS; we still unlink on exit for tidiness.
  const sessionToken = Math.random().toString(36).slice(2, 10)
  const previewStateFile = join(tmpdir(), `ccresume-preview-${sessionToken}`)
  const treeStateFile = join(tmpdir(), `ccresume-tree-${sessionToken}.json`)
  const searchFile = join(tmpdir(), `ccresume-search-${sessionToken}.tsv`)
  const groups = groupRowsByCwd(rows)
  const currentBranches = await currentBranchesByCwd(groups.map(g => g.cwd))
  await Bun.write(searchFile, rows.map(r => `${sessionSearchText(r)}\t${r.sessionId}`).join('\n'))
  const treeState: TreeState = {
    version: TREE_STATE_VERSION,
    rows: rows.map(r => ({ ...r, body: '' })),
    searchFile,
    dirLimits: {},
    collapsedDirs: {},
    searchFzfArgs: extractSearchFzfArgs(args.fzfPassthrough),
    currentBranches,
  }
  await writeTreeState(treeStateFile, treeState)

  const tsv = await renderTreeTsv(treeState, args.query)
  if (args.dump) {
    if (tsv) stdout.write(tsv + '\n')
    try {
      await unlink(treeStateFile)
    } catch {}
    try {
      await unlink(searchFile)
    } catch {}
    return
  }

  const renderCmd = renderTreeCommand(treeStateFile)
  const enterCmd = `${SELF_INVOCATION} tree-enter ${shellQuote(treeStateFile)} {2} {3}`
  const copyCmd = `${SELF_INVOCATION} tree-copy {2} {4}`
  const previewCmd = `${SELF_INVOCATION} preview-item ${shellQuote(treeStateFile)} {2} {3} {4} {5}`
  const previewLayoutCmd = `${SELF_INVOCATION} preview-layout`
  const toggleCmd = `${SELF_INVOCATION} toggle-mode`
  const userPreviewWindow = hasFzfOption(args.fzfPassthrough, '--preview-window')

  // Defaults appear BEFORE pass-through so user flags win (fzf is
  // last-wins for most flags).
  const defaultFzfArgs: string[] = [
    '--disabled',
    '--ansi',
    '--delimiter=\t',
    '--with-nth=1',
    '--accept-nth=4,5,6',
    '--track',
    '--no-hscroll',
    '--ellipsis=',
    '--height=100%',
    '--layout=reverse',
    '--info=inline',
    '--prompt=tree> ',
    '--preview', previewCmd,
    '--preview-window', autoPreviewWindow(Number(process.stdout.columns || 0), Number(process.stdout.rows || 0)),
    `--bind=change:reload(${renderCmd})`,
    `--bind=enter:transform(${enterCmd})`,
    `--bind=double-click:transform(${enterCmd})`,
    // down,67% → preview takes the bottom 2/3, list the top 1/3.
    `--bind=ctrl-/:change-preview-window(${PREVIEW_DOWN}|hidden|${PREVIEW_RIGHT})`,
    `--bind=alt-t:execute-silent(${toggleCmd})+refresh-preview`,
    // vim-style preview paging. Overrides fzf's default ctrl-b/ctrl-f
    // (backward-char/forward-char in the query); the ←/→ arrows still
    // move the query cursor.
    '--bind=ctrl-b:preview-page-up,ctrl-f:preview-page-down',
    '--header',
    `${groups.length} dirs · ${rows.length} sessions · enter/double-click [+${DIR_LIMIT_STEP}]/select · ctrl-y copy · ctrl-b/f scroll · ctrl-/ preview · alt-t full/filtered`,
  ]

  if (!userPreviewWindow) {
    defaultFzfArgs.push(
      `--bind=start:transform(${previewLayoutCmd})`,
      `--bind=resize:transform(${previewLayoutCmd})`,
    )
  }

  if (clipboardShellPipeline()) defaultFzfArgs.push(`--bind=ctrl-y:transform(${copyCmd})`)

  const fzfArgs = [...defaultFzfArgs, ...args.fzfPassthrough]
  if (args.query) fzfArgs.push('-q', args.query)

  // We don't touch FZF_DEFAULT_OPTS — user's dotfile defaults apply.
  const env = { ...process.env, CCRESUME_STATE_FILE: previewStateFile }

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
      await unlink(previewStateFile)
    } catch {}
    try {
      await unlink(treeStateFile)
    } catch {}
    try {
      await unlink(searchFile)
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
    await writeMarkdownPreview(DIM + '(no session selected — refine your query)' + RESET)
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
    await writeMarkdownPreview(DIM + `(can't read ${path}: ${(e as Error).message})` + RESET)
    return
  }
  const row = buildRow(entries, path, st, true)
  const out: string[] = []

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
    `${DIM}meta:${RESET}   ${row.messageCount}msg · ${formatBytes(row.size)} · ${formatAge(row.lastActivity)} ago`,
  ]
    .filter(Boolean)
    .map(s => highlight(s, tokens))
    .join('\n')

  out.push(header)
  out.push(DIM + '─'.repeat(60) + RESET)

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
    out.push(`\n${role}${ts}`)
    out.push(body)

    if (bytes > PREVIEW_MAX_BODY) {
      out.push(DIM + `\n…truncated (>${formatBytes(PREVIEW_MAX_BODY)})` + RESET)
      break
    }
  }

  if (tokens.length > 0) {
    if (showAll) {
      out.push(DIM + `\n${matched} of ${printed} messages contain query` + RESET)
    } else if (printed === 0) {
      out.push(DIM + `\nno message body matches "${query}" (matched on metadata)` + RESET)
      out.push(DIM + `press alt-t to view full transcript` + RESET)
    } else {
      out.push(DIM + `\n${printed}/${scanned} messages matched · alt-t for full` + RESET)
    }
  }

  await writeMarkdownPreview(out.join('\n') + '\n')
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
  } else if (sub === 'preview-item') {
    const [, stateFile, type, key, sessionId, path] = userArgs
    await runPreviewItem(stateFile!, type || '', key || '', sessionId || '', path || '')
  } else if (sub === 'preview-layout') {
    await runPreviewLayout()
  } else if (sub === 'render-tree') {
    const [, stateFile] = userArgs
    await runRenderTree(stateFile!)
  } else if (sub === 'tree-enter') {
    const [, stateFile, type, key] = userArgs
    await runTreeEnter(stateFile!, type || '', key || '')
  } else if (sub === 'tree-copy') {
    const [, type, sessionId] = userArgs
    await runTreeCopy(type || '', sessionId || '')
  } else if (sub === 'toggle-mode') {
    await runToggleMode()
  } else {
    await runLauncher(parseArgs(userArgs))
  }
}

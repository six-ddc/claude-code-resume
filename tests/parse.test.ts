import { describe, expect, test } from 'bun:test'
import {
  encodeCwd,
  stripDisplayTags,
  tokenize,
  hasMatch,
  highlight,
  snippetAroundMatches,
  shortenCwd,
  buildRow,
  readAllEntries,
  findClipboardArgv,
  VERSION,
} from '../src/claude-code-resume.ts'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// encodeCwd mirrors Claude Code's sanitizePath(). If this test breaks,
// the upstream rule changed and the picker won't find sessions until
// encodeCwd() is updated to match.
describe('encodeCwd', () => {
  test('replaces slashes with dashes', () => {
    expect(encodeCwd('/Users/foo/Code')).toBe('-Users-foo-Code')
  })
  test('replaces every non-alphanumeric', () => {
    expect(encodeCwd('/foo bar/baz.dir')).toBe('-foo-bar-baz-dir')
  })
  test('keeps digits + letters', () => {
    expect(encodeCwd('/a1B2C3')).toBe('-a1B2C3')
  })
  test('handles dotted names', () => {
    expect(encodeCwd('/x/.claude/projects')).toBe('-x--claude-projects')
  })
})

describe('stripDisplayTags', () => {
  test('removes lowercase tag blocks', () => {
    expect(stripDisplayTags('<tick>auto</tick>\nreal text')).toBe('real text')
  })
  test('falls back to original when everything is tags (default)', () => {
    expect(stripDisplayTags('<command-name>/foo</command-name>')).toBe(
      '<command-name>/foo</command-name>',
    )
  })
  test('allowEmpty returns empty for fully-tagged input', () => {
    expect(stripDisplayTags('<command-name>/foo</command-name>', true)).toBe('')
  })
  test('leaves JSX/HTML tags alone (uppercase first char)', () => {
    expect(stripDisplayTags('fix the <Button> please')).toBe('fix the <Button> please')
  })
  test('strips multiple adjacent blocks without merging', () => {
    expect(stripDisplayTags('<a>1</a><b>2</b>tail', true)).toBe('tail')
  })
})

describe('tokenize', () => {
  test('splits on whitespace and drops empties', () => {
    expect(tokenize('  foo   bar ')).toEqual(['foo', 'bar'])
  })
  test('strips fzf operator prefixes and quotes', () => {
    expect(tokenize("!skip ^prefix 'exact")).toEqual(['skip', 'prefix', 'exact'])
  })
  test('returns empty array for blank input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('hasMatch', () => {
  test('requires all tokens (AND)', () => {
    expect(hasMatch('the quick brown fox', ['quick', 'fox'])).toBe(true)
    expect(hasMatch('the quick brown fox', ['quick', 'cat'])).toBe(false)
  })
  test('case-insensitive', () => {
    expect(hasMatch('Hello World', ['hello', 'WORLD'])).toBe(true)
  })
  test('empty token list returns false (no query → no match flag)', () => {
    expect(hasMatch('anything', [])).toBe(false)
  })
})

describe('highlight', () => {
  test('wraps tokens in ANSI', () => {
    const out = highlight('foo bar', ['foo'])
    expect(out).toContain('\x1b[1;30;43m')
    expect(out).toContain('foo')
    expect(out).toContain('\x1b[0m')
  })
  test('escapes regex metacharacters in tokens', () => {
    // a literal '.' shouldn't match every character
    expect(highlight('abc.def', ['.'])).toContain('.')
    expect(highlight('abc.def', ['.']).split('\x1b[1;30;43m').length - 1).toBe(1)
  })
  test('no tokens → identity', () => {
    expect(highlight('hello', [])).toBe('hello')
  })
})

describe('snippetAroundMatches', () => {
  test('returns context window around a match', () => {
    const text = 'a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100)
    const out = snippetAroundMatches(text, ['NEEDLE'], 10)
    expect(out).toContain('NEEDLE')
    expect(out.length).toBeLessThan(text.length)
  })
  test('merges overlapping segments', () => {
    const text = 'NEEDLE NEEDLE NEEDLE'
    const out = snippetAroundMatches(text, ['NEEDLE'], 50)
    expect(out).toContain('NEEDLE NEEDLE NEEDLE')
  })
  test('no tokens → leading slice', () => {
    expect(snippetAroundMatches('abcdef', [], 2)).toBe('abcd')
  })
})

describe('shortenCwd', () => {
  test('collapses HOME prefix', () => {
    const home = process.env.HOME
    if (!home) return
    expect(shortenCwd(`${home}/foo`)).toBe('~/foo')
    expect(shortenCwd(home)).toBe('~')
  })
  test('keeps non-home paths', () => {
    expect(shortenCwd('/opt/proj')).toBe('/opt/proj')
  })
  test('empty in → empty out', () => {
    expect(shortenCwd('')).toBe('')
  })
})

describe('readAllEntries + buildRow', () => {
  test('parses a tiny session file and produces a row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-code-resume-test-'))
    const file = join(dir, '00000000-0000-0000-0000-000000000001.jsonl')
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'a summary' }),
      JSON.stringify({
        type: 'user',
        message: { content: 'hello world' },
        cwd: '/some/cwd',
        gitBranch: 'main',
        timestamp: '2025-01-01T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi there' }] },
      }),
      JSON.stringify({ type: 'tag', tag: 'spike' }),
    ]
    await writeFile(file, lines.join('\n'), 'utf8')

    try {
      const entries = await readAllEntries(file)
      expect(entries.length).toBe(4)
      const row = buildRow(
        entries,
        file,
        { mtimeMs: 1_000, birthtimeMs: 500, size: 1234 },
        true,
      )
      expect(row.sessionId).toBe('00000000-0000-0000-0000-000000000001')
      // Title precedence: agentName > customTitle > aiTitle > summary >
      // firstPrompt — so summary wins here.
      expect(row.title).toBe('a summary')
      expect(row.firstPrompt).toBe('hello world')
      expect(row.cwd).toBe('/some/cwd')
      expect(row.branch).toBe('main')
      expect(row.tag).toBe('spike')
      expect(row.messageCount).toBe(2)
      expect(row.body).toContain('hello world')
      expect(row.body).toContain('hi there')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('handles BOM and skips malformed lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-code-resume-test-'))
    const file = join(dir, '00000000-0000-0000-0000-000000000002.jsonl')
    const content =
      '﻿' +
      JSON.stringify({ type: 'summary', summary: 'ok' }) +
      '\n' +
      'not json garbage\n' +
      JSON.stringify({ type: 'tag', tag: 't' }) +
      '\n'
    await writeFile(file, content, 'utf8')
    try {
      const entries = await readAllEntries(file)
      expect(entries.length).toBe(2)
      expect(entries[0]!.type).toBe('summary')
      expect(entries[1]!.type).toBe('tag')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('findClipboardArgv', () => {
  test('returns null or an argv (platform-dependent)', () => {
    const r = findClipboardArgv()
    expect(r === null || (Array.isArray(r) && r.length > 0)).toBe(true)
  })
})

describe('VERSION', () => {
  test('is a semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

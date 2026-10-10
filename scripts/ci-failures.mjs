// Only the failures, out of a CI log — for the run's summary page.
//
// Rich, 2026-10-10, reading CI from a phone: "What do you need from ci when it fails?" The answer
// is ten or twenty lines out of three thousand: the failing test's name and its error. This pulls
// exactly those blocks out of a captured log and writes them as Markdown, so a failed run's
// summary (the box at the top of the run, and the e-mail) is the thing to copy.
//
//   node scripts/ci-failures.mjs <step name> <log file> [<log file>…]   >> "$GITHUB_STEP_SUMMARY"
//
// It knows the shapes this repo's steps print:
//   - node --test (TAP): `not ok N - name` and the indented YAML block under it, to its `...`
//   - vitest: ` FAIL ` / `×` lines, and the assertion text that follows a FAIL heading
//   - tsc: `file(line,col): error TSnnnn: …`
//   - oxlint: `× rule: message` and the location line after it
//   - python unittest: `ERROR:` / `FAIL:` headers through their traceback, to the dashed rule
//   - anything else: the last 40 lines, so an unknown failure still says something
// Nothing here can fail the job: it only reports.

import { existsSync, readFileSync } from 'node:fs'

/** The failure blocks in one log's text, each a list of lines. Pure, so it can be tested. */
export function failures(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // TAP: `not ok 12 - the name` (any indent), then its YAML block to `...`
    if (/^\s*not ok \d+ - /.test(l)) {
      const block = [l.trim()]
      const indent = l.match(/^\s*/)[0].length
      for (let j = i + 1; j < lines.length && j < i + 60; j++) {
        const m = lines[j]
        if (/^\s*\.\.\.\s*$/.test(m)) break
        if (/^\s*(not )?ok \d+ - /.test(m) && m.match(/^\s*/)[0].length <= indent) break
        block.push(m.slice(Math.min(indent, m.match(/^\s*/)[0].length)))
      }
      // a subtest's failure is reported again by every parent; keep only the innermost
      if (!/^\s*# Subtest/.test(lines[i - 1] ?? '') || !block.some((b) => /failureType: 'subtestsFailed'/.test(b))) out.push(block)
      continue
    }
    // python unittest: ERROR: / FAIL: through the dashed rule that ends the traceback
    if (/^(ERROR|FAIL): /.test(l)) {
      const block = [l]
      for (let j = i + 1; j < lines.length && j < i + 80; j++) {
        if (/^(ERROR|FAIL): /.test(lines[j]) || /^={10,}/.test(lines[j])) break
        block.push(lines[j])
      }
      out.push(block)
      continue
    }
    // vitest: a FAIL heading and what it says, up to the next blank-then-heading
    if (/^\s*FAIL\s/.test(l)) {
      const block = [l.trim()]
      for (let j = i + 1; j < lines.length && j < i + 40; j++) {
        if (/^\s*(FAIL|⎯{3,})/.test(lines[j]) && j > i + 1) break
        block.push(lines[j])
      }
      out.push(block)
      continue
    }
    // tsc
    if (/: error TS\d+: /.test(l)) { out.push([l.trim()]); continue }
    // oxlint (errors only; warnings do not fail the step)
    if (/^\s*×\s/.test(l)) { out.push([l.trim(), ...(lines.slice(i + 1, i + 4).filter((m) => /[│╭─]|:\d+:\d+/.test(m)))]); continue }
  }
  // the TAP summary of parents repeats children; drop exact duplicates
  const seen = new Set()
  return out.filter((b) => { const k = b.join('\n'); if (seen.has(k)) return false; seen.add(k); return true })
}

/** The Markdown for one step: its blocks, or the tail of the log when nothing was recognised. */
export function summary(step, texts) {
  const blocks = texts.flatMap((t) => failures(t))
  let md = `### ✗ ${step}\n\n`
  if (blocks.length) {
    md += `${blocks.length} failure${blocks.length === 1 ? '' : 's'}:\n\n`
    for (const b of blocks.slice(0, 20)) md += '```text\n' + b.join('\n').trimEnd().slice(0, 4000) + '\n```\n\n'
    if (blocks.length > 20) md += `…and ${blocks.length - 20} more in the log.\n\n`
  } else {
    const tail = texts.join('\n').trimEnd().split('\n').slice(-40).join('\n')
    md += 'No test failure recognised; the last 40 lines:\n\n```text\n' + tail + '\n```\n\n'
  }
  return md
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [step, ...files] = process.argv.slice(2)
  const texts = files.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8'))
  process.stdout.write(summary(step ?? 'a step', texts))
}

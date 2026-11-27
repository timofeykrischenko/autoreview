#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findComment, writeComment } from './lib/gh-comment.mjs'
import { gatherClaudeStandardsContext, resolveConfig, truncateText } from './lib/jira-context.mjs'
import { resolveTaskContext } from './lib/task-context.mjs'
import { claudeEnv } from './lib/claude-env.mjs'
import { renderInitial, renderUpdate, resolveLanguages, splitTagged, tagLine } from './lib/review-comment.mjs'

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE ?? 'dontAsk'
const KEEP_FOLDED_SECTIONS = Number(process.env.KEEP_FOLDED_SECTIONS ?? 2)

const CONVENTIONS_LINES = [
  '- Entry point: CLAUDE.md (full text in prompt below) + Confluence pages linked from it.',
  '- Task context below may add the Jira or Linear task with its Confluence pages or Google Docs.',
  '- On conflict, Confluence (and ADRs) override repo docs.',
  ...(process.env.REVIEW_NOTES ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
]

function claudeArgs() {
  const args = ['--print', '--no-session-persistence']
  if (PERMISSION_MODE) args.push('--permission-mode', PERMISSION_MODE)
  return args
}

const env = (key) => {
  const value = process.env[key]
  if (!value) {
    console.error(`[auto-review] missing required env: ${key}`)
    process.exit(2)
  }
  return value
}

const PR_NUMBER = env('PR_NUMBER')
const REPO = env('REPO')
const HEAD_SHA = env('HEAD_SHA')
const SHORT_SHA = HEAD_SHA.slice(0, 7)
const TIMESTAMP = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const LANGUAGES = resolveLanguages(process.env.REVIEW_LANGUAGES || 'ru')
const PRIMARY_LANGUAGE = LANGUAGES[0]
const BILINGUAL = LANGUAGES.length > 1

function languageLines(subject) {
  if (!BILINGUAL) {
    return [
      `- Write ${subject} in ${PRIMARY_LANGUAGE.name} (headings, prose, everything). Keep code identifiers, file paths and CLI commands verbatim.`,
    ]
  }
  return [
    `- Write ${subject} once per language, each version after its own marker line:`,
    ...LANGUAGES.map((language) => `    ${tagLine('lang', language.code)} followed by the whole text in ${language.name}`),
    '- Each marker sits alone on its own line, nothing else on it. Start the output with the first marker.',
    '- All versions report the SAME findings in the SAME order: they are translations of one review, not separate reviews.',
    '- Keep code identifiers, file paths and CLI commands verbatim in every version.',
  ]
}

function standardsContextBlock(standardsContext) {
  if (!standardsContext) return []
  return [
    'Project standards (CLAUDE.md + linked Confluence pages):',
    '',
    standardsContext,
    '',
    '---',
    '',
  ]
}

function taskContextBlock(taskContext) {
  if (!taskContext) return []
  return [
    'Use the task requirements below to judge whether the PR actually fulfils them.',
    'Flag missing requirements and acceptance criteria, not just code-level issues.',
    '',
    taskContext,
    '',
    '---',
    '',
  ]
}

function buildPrompt(previousBody, standardsContext, taskContext) {
  if (!previousBody) {
    return [
      ...standardsContextBlock(standardsContext),
      ...taskContextBlock(taskContext),
      `Run \`/review ${PR_NUMBER}\` for repository ${REPO}.`,
      `Current commit: ${SHORT_SHA}.`,
      '',
      'Output requirements:',
      ...languageLines('the ENTIRE review'),
      '- Pure markdown. No preamble, no "Here is your review" sentences.',
      '- Sections: Critical, High, Medium, Minor (omit sections with no findings).',
      '- Number findings in one sequence across all sections (1, 2, 3...), later iterations refer to these numbers.',
      '- For each finding: file path, line number when applicable, what is wrong, suggested fix.',
      '- Focus on correctness, security, performance, and project conventions.',
      ...CONVENTIONS_LINES,
      '- Call out requirements from the task context that the PR does not address.',
    ].join('\n')
  }

  return [
    ...standardsContextBlock(standardsContext),
    ...taskContextBlock(taskContext),
    `Follow-up review on PR #${PR_NUMBER} in ${REPO} at commit ${SHORT_SHA}.`,
    '',
    'PREVIOUS REVIEW (your earlier comments on this PR, full markdown):',
    '```markdown',
    previousBody,
    '```',
    '',
    'For THIS iteration:',
    `1. Run \`gh pr diff ${PR_NUMBER}\` to inspect the current diff.`,
    '2. For wiki/Confluence/docs findings, re-check the "Project standards" block above (not only the diff); if Confluence matches the repo, mark ✅ FIXED even when the PR diff is unchanged.',
    '3. In the UPDATE, report a status bullet ONLY for items whose state changed in this commit:',
    '   - ✅ FIXED — short note on what changed',
    '   - 🟡 PARTIAL — partial fix, what is missing',
    '4. An item already marked ✅ FIXED in an earlier section stays fixed: never repeat it. Regressions are the exception — report those as 🆕 New.',
    '5. List newly introduced issues in the UPDATE under "🆕 New" with file path and line.',
    '6. Keep the UPDATE under 20 lines. Nothing changed and nothing new? Then a single line saying so is the correct UPDATE.',
    '7. Write the SUMMARY: the state of the whole PR at this commit, built from the previous review and this iteration.',
    '   - One line per finding that is still open, PARTIAL included: severity, finding number, short title, file path.',
    '   - One more line for task requirements from the task context that the PR still does not meet, if any.',
    '   - Nothing open? Then a single line saying the PR has no open findings.',
    '   - Under 15 lines. Do not re-describe the findings, they are already written in the previous review.',
    '8. Output the SUMMARY first and the UPDATE second, each after its own marker line:',
    `    ${tagLine('part', 'summary')}`,
    `    ${tagLine('part', 'update')}`,
    '   Each marker sits alone on its own line. No comment marker, no top-level title, no headings of your own: the script adds them.',
    ...languageLines('the SUMMARY and the UPDATE').map((line) => `   ${line}`),
  ].join('\n')
}

function runClaude(prompt) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-review-'))
  const promptFile = join(dir, 'prompt.txt')
  writeFileSync(promptFile, prompt, 'utf8')
  try {
    const result = spawnSync(CLAUDE_BIN, claudeArgs(), {
      input: readFileSync(promptFile, 'utf8'),
      env: claudeEnv(process.env),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    })
    if (result.error) {
      console.error(`[auto-review] failed to spawn ${CLAUDE_BIN}: ${result.error.message}`)
      process.exit(1)
    }
    if (result.stderr?.trim()) {
      console.error(`[auto-review] claude stderr:\n${truncateText(result.stderr.trim(), 4000)}`)
    }
    if (result.status !== 0) {
      console.error(`[auto-review] claude exited with ${result.status}`)
      process.exit(result.status ?? 1)
    }
    return result.stdout.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function splitByLanguage(output) {
  if (!BILINGUAL) return new Map([[PRIMARY_LANGUAGE.code, output]])
  const reviews = splitTagged(output, 'lang')
  if (reviews.size === 0) {
    console.log(
      `::warning::auto-review: no language markers in the output, posting the whole review as ${PRIMARY_LANGUAGE.name}`
    )
    reviews.set(PRIMARY_LANGUAGE.code, output)
  }
  return reviews
}

function splitUpdate(language, text) {
  const parts = splitTagged(text, 'part')
  if (parts.size > 0) return { summary: parts.get('summary') ?? null, update: parts.get('update') ?? '' }
  console.log(`::warning::auto-review: ${language.code}: no part markers in the output, posting it as the update without a summary`)
  return { summary: null, update: text }
}

function publish(language, existing, text) {
  if (!existing) {
    writeComment({
      repo: REPO,
      pr: PR_NUMBER,
      body: renderInitial(language, { timestamp: TIMESTAMP, sha: SHORT_SHA, review: text }),
    })
    console.log(`[auto-review] ${language.code}: created new comment`)
    return
  }

  const { summary, update } = splitUpdate(language, text)
  const { body, kept, total } = renderUpdate(language, {
    previousBody: existing.body,
    timestamp: TIMESTAMP,
    sha: SHORT_SHA,
    summary,
    update,
    keep: KEEP_FOLDED_SECTIONS,
  })
  writeComment({ repo: REPO, pr: PR_NUMBER, id: existing.id, body })
  console.log(
    `[auto-review] ${language.code}: updated comment ${existing.id} (kept ${kept} of ${total} earlier section(s))`
  )
}

async function resolveStandardsContext(config) {
  const result = await gatherClaudeStandardsContext({
    config,
    log: (message) => console.error(message),
  })
  if (!result) {
    console.log('[auto-review] standards: CLAUDE.md not found — skipping')
    return null
  }
  console.log(
    `[auto-review] standards: CLAUDE.md + ${result.fetchedPageIds.length} Confluence page(s)`
  )
  return result
}

async function main() {
  console.log(`[auto-review] PR #${PR_NUMBER} @ ${SHORT_SHA}, languages: ${LANGUAGES.map((l) => l.code).join(', ')}`)

  const config = resolveConfig()
  const standards = await resolveStandardsContext(config)
  const excludePageIds = new Set(standards?.fetchedPageIds ?? [])
  const taskContext = await resolveTaskContext({
    excludePageIds,
    confluenceSpentChars: standards?.confluenceSpentChars ?? 0,
    log: (message) => console.error(message),
  })
  console.log(`[auto-review] task context: ${taskContext ? 'attached' : 'none'}`)
  const existingComments = new Map(
    LANGUAGES.map((language) => [
      language.code,
      findComment({ repo: REPO, pr: PR_NUMBER, marker: language.marker }),
    ])
  )
  const previousBody = existingComments.get(PRIMARY_LANGUAGE.code)?.body
  const prompt = buildPrompt(previousBody, standards?.markdown ?? null, taskContext)
  console.log(`[auto-review] mode: ${previousBody ? 'update' : 'initial'}`)

  const output = runClaude(prompt)
  if (!output) {
    console.error('[auto-review] claude returned empty output, aborting comment update')
    process.exit(1)
  }

  const reviews = splitByLanguage(output)
  for (const language of LANGUAGES) {
    const text = reviews.get(language.code)
    if (!text) {
      console.log(
        `::warning::auto-review: the ${language.name} version is missing from the output, leaving that comment untouched`
      )
      continue
    }
    publish(language, existingComments.get(language.code), text)
  }
}

main().catch((error) => {
  console.error(`[auto-review] fatal: ${error.message}`)
  process.exit(1)
})

import { GITHUB_COMMENT_MAX, fitToLimit } from './gh-comment.mjs'

export const LANGUAGES = {
  ru: {
    code: 'ru',
    name: 'Russian',
    marker: '<!-- claude-auto-review v1 -->',
    title: '## 🤖 Claude auto-review',
    summaryTitle: 'Резюме',
    historyLabel: (kept, history) =>
      history.dropped > 0
        ? `Предыдущие итерации: первое ревью и последние ${kept}`
        : `Предыдущие итерации (${history.total})`,
    truncated: `> _(обрезано до лимита GitHub ${GITHUB_COMMENT_MAX} символов, показаны последние итерации)_\n\n`,
  },
  en: {
    code: 'en',
    name: 'English',
    marker: '<!-- claude-auto-review v1 en -->',
    title: '## 🤖 Claude auto-review (English)',
    summaryTitle: 'Summary',
    historyLabel: (kept, history) =>
      history.dropped > 0
        ? `Previous iterations: the initial review and the last ${kept}`
        : `Previous iterations (${history.total})`,
    truncated: `> _(truncated to the GitHub limit of ${GITHUB_COMMENT_MAX} characters, showing the latest iterations)_\n\n`,
  },
}

export const HISTORY_START = '<!-- history:start -->'
export const HISTORY_END = '<!-- history:end -->'

export function resolveLanguages(codes = 'ru') {
  return codes
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean)
    .map((code) => {
      if (!LANGUAGES[code]) throw new Error(`unknown review language: ${code}`)
      return LANGUAGES[code]
    })
}

export const tagLine = (tag, value) => `<!-- ${tag}:${value} -->`

export function splitTagged(output, tag) {
  const parts = new Map()
  const pattern = new RegExp(`^[ \\t]*<!--[ \\t]*${tag}:([a-z]+)[ \\t]*-->[ \\t]*$`, 'gim')
  const matches = [...output.matchAll(pattern)]

  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : output.length
    const text = output.slice(start, end).trim()
    if (text) parts.set(match[1].toLowerCase(), text)
  }

  return parts
}

function splitSections(text) {
  return text
    .split(/\n(?=### (?:Initial review|Update) — \d{4}-)/)
    .map((section) => section.replace(/\n*-{3,}\s*$/, '').trim())
    .filter(Boolean)
}

export function keepRecentSections(text, keep) {
  const sections = splitSections(text)
  const initial = sections[0]?.startsWith('### Initial review') ? sections.slice(0, 1) : []
  const updates = sections.slice(initial.length)
  const kept = keep > 0 ? updates.slice(-keep) : []
  return {
    text: [...initial, ...kept].join('\n\n'),
    total: sections.length,
    dropped: updates.length - kept.length,
  }
}

function findLine(text, line) {
  return text.search(new RegExp(`^${line}$`, 'm'))
}

export function foldPreviousSections(previousBody) {
  const historyStart = findLine(previousBody, HISTORY_START)
  if (historyStart === -1) {
    const firstSection = previousBody.search(/^### (?:Initial review|Update) — \d{4}-/m)
    return firstSection === -1 ? '' : previousBody.slice(firstSection).trim()
  }

  const historyEnd = findLine(previousBody, HISTORY_END)
  const history = previousBody.slice(historyStart + HISTORY_START.length, historyEnd)
  const inner = history
    .replace(/^\s*<details>[\s\S]*?<\/summary>/, '')
    .replace(/<\/details>\s*$/, '')
    .trim()
  const latest = previousBody.slice(historyEnd + HISTORY_END.length).trim()

  return [inner, latest].filter(Boolean).join('\n\n')
}

export function renderInitial(language, { timestamp, sha, review }) {
  const render = (text) =>
    [language.marker, language.title, '', `### Initial review — ${timestamp} — \`${sha}\``, '', text].join('\n')
  return fitToLimit(render, review, language.truncated)
}

export function renderUpdate(language, { previousBody, timestamp, sha, summary, update, keep }) {
  const history = keepRecentSections(foldPreviousSections(previousBody), keep)
  const summaryBlock = summary ? [`### ${language.summaryTitle} — \`${sha}\``, '', summary, ''] : []

  const render = (historyText) =>
    [
      language.marker,
      language.title,
      '',
      ...summaryBlock,
      HISTORY_START,
      `<details><summary>${language.historyLabel(keep, history)}</summary>`,
      '',
      historyText,
      '',
      '</details>',
      HISTORY_END,
      '',
      `### Update — ${timestamp} — \`${sha}\``,
      '',
      update,
    ].join('\n')

  return {
    body: fitToLimit(render, history.text, language.truncated),
    kept: history.total - history.dropped,
    total: history.total,
  }
}

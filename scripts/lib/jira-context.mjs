import { readFile as fsReadFile } from 'node:fs/promises'
import process from 'node:process'

const DEFAULT_BASE_URL = 'https://535media.atlassian.net'

export const DEFAULT_LIMITS = {
  maxConfluencePages: 30,
  maxPageChars: 20000,
  maxFieldChars: 10000,
  maxTotalChars: 300000,
}

export function truncateText(text, max) {
  if (!text) return ''
  if (!(max > 0) || text.length <= max) return text
  return `${text.slice(0, max)}\n\n…[truncated, ${text.length - max} more chars]`
}

export function capList(items, max) {
  const list = items || []
  if (!(max > 0) || list.length <= max) return { kept: list, dropped: 0 }
  return { kept: list.slice(0, max), dropped: list.length - max }
}

export function extractIssueKey(sources, prefix = 'DFUSION') {
  const re = new RegExp(`\\b(${prefix}-\\d+)\\b`, 'i')
  for (const source of sources) {
    if (!source) continue
    const match = String(source).match(re)
    if (match) return match[1].toUpperCase()
  }
  return null
}

export function isEpicIssuetype(issuetype) {
  if (!issuetype) return false
  if (typeof issuetype.name === 'string' && issuetype.name.toLowerCase() === 'epic') return true
  if (typeof issuetype.hierarchyLevel === 'number' && issuetype.hierarchyLevel >= 1) return true
  return false
}

export function adfToText(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(adfToText).join('')

  let out = ''

  if (node.type === 'text' && typeof node.text === 'string') out += node.text

  const cardUrl = node.attrs && (node.attrs.url || node.attrs.href)
  if (cardUrl && ['inlineCard', 'blockCard', 'embedCard'].includes(node.type)) {
    out += ` ${cardUrl} `
  }

  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (mark?.type === 'link' && mark.attrs?.href) out += ` ${mark.attrs.href} `
    }
  }

  if (node.content) out += adfToText(node.content)

  if (
    ['paragraph', 'heading', 'listItem', 'tableRow', 'blockquote', 'codeBlock'].includes(node.type)
  ) {
    out += '\n'
  }

  return out
}

export function stripHtml(html) {
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractConfluenceLinks(text, host = '535media.atlassian.net') {
  if (!text) return []
  const escapedHost = host.replace(/\./g, '\\.')
  const re = new RegExp(
    `https?://${escapedHost}/wiki/[^\\s)\\]"'<>]*?/pages/(\\d+)(?:/[^\\s)\\]"'<>]*)?`,
    'g'
  )
  const seen = new Map()
  let match
  while ((match = re.exec(text)) !== null) {
    const pageId = match[1]
    if (!seen.has(pageId)) seen.set(pageId, { pageId, url: match[0] })
  }
  return [...seen.values()]
}

export function formatJiraContext({ task, parents = [], specs = [] }) {
  if (!task) return ''

  const lines = ['## Task context (from Jira)', '']

  lines.push(`### Task ${task.key}: ${task.summary || ''}`.trimEnd())
  lines.push('')
  lines.push(task.description?.trim() || '_(no description)_')
  lines.push('')

  for (const parent of parents) {
    const label = parent.isEpic ? 'Epic' : 'Parent'
    lines.push(`### ${label} ${parent.key}: ${parent.summary || ''}`.trimEnd())
    lines.push('')
    lines.push(parent.description?.trim() || '_(no description)_')
    lines.push('')
  }

  for (const spec of specs) {
    lines.push(`### Spec (Confluence): ${spec.title || spec.url || ''}`.trimEnd())
    if (spec.url) lines.push(`<${spec.url}>`)
    lines.push('')
    lines.push(spec.text?.trim() || '_(empty page)_')
    lines.push('')
  }

  return lines.join('\n').trim()
}

export function demoteMarkdownHeadings(text, by = 1) {
  if (!text) return ''
  if (!(by > 0)) return text

  const lines = text.split('\n')
  let inFence = false
  const fenceRe = /^(```+|~~~+)/
  const headingRe = /^(#{1,6})(\s+.*)$/

  return lines
    .map((line) => {
      const trimmed = line.trimStart()
      if (fenceRe.test(trimmed)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line

      const match = trimmed.match(headingRe)
      if (!match) return line

      const level = Math.min(6, match[1].length + by)
      const indent = line.slice(0, line.length - trimmed.length)
      return `${indent}${'#'.repeat(level)}${match[2]}`
    })
    .join('\n')
}

export function formatStandardsContext({ claudePath = 'CLAUDE.md', claudeText, specs = [] }) {
  const lines = ['## Project standards (CLAUDE.md)', '']

  if (claudePath) {
    lines.push(`Source: \`${claudePath}\``, '')
  }

  const embeddedClaude = claudeText?.trim()
    ? demoteMarkdownHeadings(claudeText.trim(), 2)
    : '_(empty file)_'
  lines.push(embeddedClaude, '')

  for (const spec of specs) {
    lines.push(`### Standard (Confluence): ${spec.title || spec.url || ''}`.trimEnd())
    if (spec.url) lines.push(`<${spec.url}>`)
    lines.push('')
    lines.push(spec.text?.trim() || '_(empty page)_')
    lines.push('')
  }

  return lines.join('\n').trim()
}

function intFromEnv(value, fallback) {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function resolveConfig(env = process.env) {
  const baseUrl = (env.ATLASSIAN_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
  const host = baseUrl.replace(/^https?:\/\//, '')
  return {
    baseUrl,
    host,
    email: env.ATLASSIAN_EMAIL || '',
    token: env.ATLASSIAN_API_TOKEN || '',
    limits: {
      maxConfluencePages: intFromEnv(env.MAX_CONFLUENCE_PAGES, DEFAULT_LIMITS.maxConfluencePages),
      maxPageChars: intFromEnv(env.MAX_PAGE_CHARS, DEFAULT_LIMITS.maxPageChars),
      maxFieldChars: intFromEnv(env.MAX_FIELD_CHARS, DEFAULT_LIMITS.maxFieldChars),
      maxTotalChars: intFromEnv(env.MAX_TOTAL_CHARS, DEFAULT_LIMITS.maxTotalChars),
    },
  }
}

function authHeader(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
}

async function atlassianGet(path, config) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    headers: { Authorization: authHeader(config.email, config.token), Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`Atlassian GET ${path} -> HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchIssue(key, config) {
  const data = await atlassianGet(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,parent,issuetype`,
    config
  )
  const fields = data.fields || {}
  return {
    key: data.key,
    summary: fields.summary || '',
    description: adfToText(fields.description),
    issuetype: fields.issuetype || {},
    parentKey: fields.parent?.key || null,
  }
}

export async function fetchConfluencePage(pageId, config) {
  const data = await atlassianGet(
    `/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.view`,
    config
  )
  const base = data._links?.base || `${config.baseUrl}/wiki`
  const webui = data._links?.webui || ''
  return {
    pageId,
    title: data.title || '',
    text: stripHtml(data.body?.view?.value || ''),
    url: webui ? `${base}${webui}` : '',
  }
}

export async function fetchConfluenceSpecsForLinks(
  links,
  config,
  limits,
  log = () => {},
  excludePageIds = new Set()
) {
  const specs = []
  let totalChars = 0
  let budgetStoppedAt = -1
  const filtered = (links || []).filter((link) => !excludePageIds.has(link.pageId))

  for (let i = 0; i < filtered.length; i += 1) {
    const link = filtered[i]
    try {
      const page = await fetchConfluencePage(link.pageId, config)
      const text = truncateText(page.text, limits.maxPageChars)
      if (
        limits.maxTotalChars > 0 &&
        specs.length > 0 &&
        totalChars + text.length > limits.maxTotalChars
      ) {
        budgetStoppedAt = i
        break
      }
      specs.push({ ...page, text })
      totalChars += text.length
    } catch (error) {
      log(`[confluence] failed to fetch page ${link.pageId}: ${error.message}`)
    }
  }

  if (budgetStoppedAt >= 0) {
    log(
      `[confluence] total spec budget ${limits.maxTotalChars} chars reached; included ${specs.length}/${filtered.length} pages, skipped ${filtered.length - budgetStoppedAt}`
    )
  }

  return { specs, spentChars: totalChars }
}

function remainingConfluenceBudget(limits, confluenceSpentChars = 0) {
  if (!(limits.maxTotalChars > 0)) return limits.maxTotalChars
  return Math.max(0, limits.maxTotalChars - confluenceSpentChars)
}

export function mergeConfluenceLinks(linkGroups, host = '535media.atlassian.net') {
  const seen = new Set()
  const merged = []
  for (const group of linkGroups) {
    for (const link of extractConfluenceLinks(group, host)) {
      if (seen.has(link.pageId)) continue
      seen.add(link.pageId)
      merged.push(link)
    }
  }
  return merged
}

export async function gatherClaudeStandardsContext({
  claudePath = 'CLAUDE.md',
  contributingPath = 'CONTRIBUTING.md',
  config,
  readFile = fsReadFile,
  log = () => {},
}) {
  let claudeText
  try {
    claudeText = await readFile(claudePath, 'utf8')
  } catch (error) {
    log(`[standards] failed to read ${claudePath}: ${error.message}`)
    return null
  }

  let contributingText = ''
  try {
    contributingText = await readFile(contributingPath, 'utf8')
  } catch {
  }

  const limits = { ...DEFAULT_LIMITS, ...(config?.limits || {}) }
  const links = mergeConfluenceLinks([claudeText, contributingText], config?.host)
  const { kept: cappedLinks, dropped } = capList(links, limits.maxConfluencePages)
  if (dropped > 0) {
    log(
      `[standards] ${links.length} Confluence links in ${claudePath} + ${contributingPath}; capped at ${limits.maxConfluencePages}, dropped ${dropped}`
    )
  }

  let specs = []
  let confluenceSpentChars = 0
  if (cappedLinks.length > 0) {
    if (!config?.email || !config?.token) {
      log('[standards] ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN not set — Confluence links not fetched')
    } else {
      const fetched = await fetchConfluenceSpecsForLinks(cappedLinks, config, limits, log)
      specs = fetched.specs
      confluenceSpentChars = fetched.spentChars
    }
  }

  return {
    markdown: formatStandardsContext({ claudePath, claudeText, specs }),
    fetchedPageIds: specs.map((spec) => spec.pageId),
    confluenceSpentChars,
  }
}

export async function gatherJiraContext({
  issueKey,
  config,
  maxDepth = 3,
  excludePageIds = new Set(),
  confluenceSpentChars = 0,
  log = () => {},
}) {
  if (!issueKey) return null
  if (!config?.email || !config?.token) {
    log('[jira] ATLASSIAN_EMAIL/ATLASSIAN_API_TOKEN not set — skipping Jira context')
    return null
  }

  try {
    const task = await fetchIssue(issueKey, config)

    const parents = []
    let parentKey = task.parentKey
    let depth = 0
    while (parentKey && depth < maxDepth) {
      const parent = await fetchIssue(parentKey, config)
      const isEpic = isEpicIssuetype(parent.issuetype)
      parents.push({ ...parent, isEpic })
      depth += 1
      if (isEpic) break
      parentKey = parent.parentKey
    }

    const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) }

    const descriptions = [task.description, ...parents.map((p) => p.description)]
    const allLinks = []
    const seen = new Set()
    for (const description of descriptions) {
      for (const link of extractConfluenceLinks(description, config.host)) {
        if (!seen.has(link.pageId)) {
          seen.add(link.pageId)
          allLinks.push(link)
        }
      }
    }

    const jiraOnlyLinks = allLinks.filter((link) => !excludePageIds.has(link.pageId))
    const { kept: links, dropped } = capList(jiraOnlyLinks, limits.maxConfluencePages)
    if (dropped > 0) {
      log(
        `[jira] ${jiraOnlyLinks.length} Confluence links found; capped at ${limits.maxConfluencePages}, dropped ${dropped}`
      )
    }

    const remainingTotalChars = remainingConfluenceBudget(limits, confluenceSpentChars)
    let specs = []
    if (remainingTotalChars === 0 && limits.maxTotalChars > 0) {
      log('[jira] Confluence total budget exhausted by standards — skipping Jira wiki pages')
    } else {
      const fetched = await fetchConfluenceSpecsForLinks(
        links,
        config,
        { ...limits, maxTotalChars: remainingTotalChars },
        log
      )
      specs = fetched.specs
    }

    return formatJiraContext({
      task: {
        key: task.key,
        summary: task.summary,
        description: truncateText(task.description, limits.maxFieldChars),
      },
      parents: parents.map((p) => ({
        key: p.key,
        summary: p.summary,
        description: truncateText(p.description, limits.maxFieldChars),
        isEpic: p.isEpic,
      })),
      specs,
    })
  } catch (error) {
    log(`[jira] context gathering failed: ${error.message}`)
    return null
  }
}

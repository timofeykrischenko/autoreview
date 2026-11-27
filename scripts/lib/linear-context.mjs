import { demoteMarkdownHeadings, truncateText } from './jira-context.mjs'

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql'
const DEFAULT_MAX_FIELD_CHARS = 10000

const ISSUE_QUERY = `query Issue($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes {
      identifier
      title
      description
      parent { identifier title description }
      project { name description content documents(first: 50) { nodes { title url content } } }
      attachments { nodes { title url } }
    }
  }
}`

const TRANSLATED_BLOCK = /^(\+\+\+|>>>)[ \t]*RU Version \(auto-translated\)[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|(?![\s\S]))/m

export function stripTranslatedBlock(text) {
  if (!text) return ''
  return text.replace(TRANSLATED_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function resolveLinearConfig(env = process.env) {
  const maxFieldChars = Number.parseInt(env.MAX_FIELD_CHARS ?? '', 10)
  return {
    apiKey: env.LINEAR_API_KEY || '',
    endpoint: env.LINEAR_ENDPOINT || DEFAULT_ENDPOINT,
    prefixes: (env.LINEAR_TEAM_PREFIX || '')
      .split(',')
      .map((prefix) => prefix.trim().toUpperCase())
      .filter(Boolean),
    maxFieldChars: Number.isFinite(maxFieldChars) && maxFieldChars >= 0 ? maxFieldChars : DEFAULT_MAX_FIELD_CHARS,
  }
}

export function extractLinearIdentifier(sources, prefixes) {
  if (!prefixes?.length) return null
  const escaped = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`\\b((?:${escaped.join('|')})-\\d+)\\b`, 'i')
  for (const source of sources) {
    if (!source) continue
    const match = String(source).match(re)
    if (match) return match[1].toUpperCase()
  }
  return null
}

function parseIdentifier(identifier) {
  const match = String(identifier ?? '').match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/)
  return match ? { teamKey: match[1].toUpperCase(), number: Number.parseInt(match[2], 10) } : null
}

export async function gatherLinearContext({ identifier, config, fetchImpl = fetch, log = () => {} }) {
  if (!config?.apiKey) {
    log('[linear] LINEAR_API_KEY not set — skipping task context')
    return null
  }
  const parsed = parseIdentifier(identifier)
  if (!parsed) {
    log(`[linear] cannot parse identifier: ${identifier}`)
    return null
  }

  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { Authorization: config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ISSUE_QUERY, variables: parsed }),
    })
    if (!response.ok) {
      log(`[linear] GraphQL HTTP ${response.status} for ${identifier}`)
      return null
    }
    const payload = await response.json()
    const node = payload?.data?.issues?.nodes?.[0]
    if (!node) {
      log(`[linear] issue ${identifier} not found`)
      return null
    }
    const issueOf = (raw) => ({
      identifier: raw.identifier,
      title: raw.title || '',
      description: stripTranslatedBlock(raw.description),
    })
    return {
      issue: issueOf(node),
      parent: node.parent ? issueOf(node.parent) : null,
      project: node.project
        ? {
            name: node.project.name || '',
            description: stripTranslatedBlock(node.project.description),
            content: stripTranslatedBlock(node.project.content),
            documents: (node.project.documents?.nodes ?? [])
              .map((document) => ({
                title: document.title || '',
                url: document.url || '',
                content: stripTranslatedBlock(document.content),
              }))
              .filter((document) => document.content),
          }
        : null,
      attachments: (node.attachments?.nodes ?? [])
        .filter((attachment) => attachment?.url)
        .map((attachment) => ({ title: attachment.title || '', url: attachment.url })),
    }
  } catch (error) {
    log(`[linear] context gathering failed: ${error.message}`)
    return null
  }
}

export function formatTaskContext({ issue, parent, project, attachments = [], specs = [], maxFieldChars = 0 }) {
  if (!issue) return ''
  const cap = (text) => demoteMarkdownHeadings(maxFieldChars ? truncateText(text, maxFieldChars) : text, 3)
  const lines = ['## Task context (from Linear)', '']

  lines.push(`### Task ${issue.identifier}: ${issue.title || ''}`.trimEnd(), '')
  lines.push(cap(issue.description)?.trim() || '_(no description)_', '')

  if (parent) {
    lines.push(`### Parent ${parent.identifier}: ${parent.title || ''}`.trimEnd(), '')
    lines.push(cap(parent.description)?.trim() || '_(no description)_', '')
  }

  if (project) {
    lines.push(`### Project: ${project.name || ''}`.trimEnd(), '')
    const overview = [project.description, project.content].map((text) => cap(text)?.trim()).filter(Boolean)
    lines.push(overview.join('\n\n') || '_(no description)_', '')
    for (const document of project.documents ?? []) {
      lines.push(`### Project document: ${document.title || document.url}`.trimEnd())
      if (document.url) lines.push(`<${document.url}>`)
      lines.push('', cap(document.content).trim(), '')
    }
  }

  if (attachments.length) {
    lines.push('### Attachments', '')
    for (const attachment of attachments) lines.push(`- ${attachment.title || attachment.url}: <${attachment.url}>`)
    lines.push('')
  }

  for (const spec of specs) {
    lines.push(`### Spec (Google): ${spec.title || spec.url || ''}`.trimEnd())
    if (spec.url) lines.push(`<${spec.url}>`)
    lines.push('', spec.text?.trim() || '_(empty document)_', '')
  }

  return lines.join('\n').trim()
}

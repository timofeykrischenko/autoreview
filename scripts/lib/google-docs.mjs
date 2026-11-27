import { createSign } from 'node:crypto'
import { truncateText } from './jira-context.mjs'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

export const DEFAULT_LIMITS = {
  maxDocs: 20,
  maxDocChars: 20000,
  maxTotalChars: 300000,
}

const EXPORT_MIME = {
  document: 'text/plain',
  spreadsheets: 'text/csv',
}

export function extractGoogleLinks(text) {
  if (!text) return []
  const re = /https?:\/\/docs\.google\.com\/(document|spreadsheets)\/d\/([A-Za-z0-9_-]+)/g
  const seen = new Map()
  for (const [, type, id] of text.matchAll(re)) {
    if (!seen.has(id)) seen.set(id, { type, id, url: `https://docs.google.com/${type}/d/${id}` })
  }
  return [...seen.values()]
}

const base64url = (input) => Buffer.from(input).toString('base64url')

function jwtAssertion(key, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: DRIVE_SCOPE,
      aud: key.token_uri || DEFAULT_TOKEN_URI,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(key.private_key).toString('base64url')}`
}

async function accessToken(key, fetchImpl, nowSeconds) {
  const authorizedUser = key.type === 'authorized_user' || (!key.private_key && !!key.refresh_token)
  const body = authorizedUser
    ? new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: key.refresh_token,
      })
    : new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwtAssertion(key, nowSeconds),
      })
  const response = await fetchImpl(key.token_uri || DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) throw new Error(`Google token exchange -> HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload?.access_token) throw new Error('Google token exchange returned no access_token')
  return payload.access_token
}

function parseKey(saKey, log) {
  if (!saKey) {
    log('[google] GOOGLE_SA_KEY not set — skipping Google document specs')
    return null
  }
  if (typeof saKey !== 'string') return saKey
  try {
    return JSON.parse(saKey)
  } catch {
    log('[google] GOOGLE_SA_KEY is not valid JSON — skipping Google document specs')
    return null
  }
}

async function docName(id, token, fetchImpl) {
  const response = await fetchImpl(`${DRIVE_FILES}/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) return ''
  return (await response.json())?.name || ''
}

async function docText(link, token, fetchImpl) {
  const mime = encodeURIComponent(EXPORT_MIME[link.type] || 'text/plain')
  const response = await fetchImpl(
    `${DRIVE_FILES}/${encodeURIComponent(link.id)}/export?mimeType=${mime}&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ').trim()
    throw new Error(`Drive export ${link.id} -> HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return response.text()
}

export async function gatherGoogleSpecs({
  descriptions = [],
  saKey,
  fetchImpl = fetch,
  limits = {},
  log = () => {},
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const key = parseKey(saKey, log)
  if (!key) return []
  const effective = { ...DEFAULT_LIMITS, ...limits }

  const seen = new Map()
  for (const description of descriptions) {
    for (const link of extractGoogleLinks(description)) if (!seen.has(link.id)) seen.set(link.id, link)
  }
  let links = [...seen.values()]
  if (!links.length) return []
  if (effective.maxDocs > 0 && links.length > effective.maxDocs) {
    log(`[google] ${links.length} document links found; capped at ${effective.maxDocs}`)
    links = links.slice(0, effective.maxDocs)
  }

  let token
  try {
    token = await accessToken(key, fetchImpl, nowSeconds)
  } catch (error) {
    log(`[google] auth failed: ${error.message}`)
    return []
  }

  const specs = []
  let totalChars = 0
  for (const link of links) {
    try {
      const [title, raw] = await Promise.all([docName(link.id, token, fetchImpl), docText(link, token, fetchImpl)])
      const text = truncateText(raw, effective.maxDocChars)
      if (effective.maxTotalChars > 0 && specs.length > 0 && totalChars + text.length > effective.maxTotalChars) {
        log(`[google] total spec budget ${effective.maxTotalChars} chars reached; included ${specs.length}/${links.length}`)
        break
      }
      specs.push({ id: link.id, title, url: link.url, text })
      totalChars += text.length
    } catch (error) {
      log(`[google] failed to fetch document ${link.id}: ${error.message}`)
    }
  }
  return specs
}

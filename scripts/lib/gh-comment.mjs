import { spawnSync } from 'node:child_process'

export const GITHUB_COMMENT_MAX = 65536

function gh(args, opts = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', ...opts })
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : ''
    throw new Error(`gh ${args.join(' ')} failed (exit ${result.status})${stderr}`)
  }
  return result.stdout
}

export function fitToLimit(render, variable, notice = '') {
  const full = render(variable)
  if (full.length <= GITHUB_COMMENT_MAX) return full
  const budget = GITHUB_COMMENT_MAX - render(notice).length
  return render(notice + variable.slice(Math.max(0, variable.length - budget)))
}

export function findComment({ repo, pr, marker }) {
  const raw = gh([
    'api',
    `repos/${repo}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    `[.[] | select(.body | contains("${marker}"))] | first`,
  ])
  const parsed = raw.trim() ? JSON.parse(raw) : null
  if (!parsed) return null
  return { id: parsed.id, body: parsed.body }
}

export function writeComment({ repo, pr, id, body }) {
  if (id) {
    gh(['api', `repos/${repo}/issues/comments/${id}`, '--method', 'PATCH', '--input', '-'], {
      input: JSON.stringify({ body }),
    })
    return { id, action: 'updated' }
  }
  gh(['api', `repos/${repo}/issues/${pr}/comments`, '--method', 'POST', '--input', '-'], {
    input: JSON.stringify({ body }),
  })
  return { action: 'created' }
}

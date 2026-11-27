import { extractIssueKey, gatherJiraContext, resolveConfig } from './jira-context.mjs'
import { extractLinearIdentifier, formatTaskContext, gatherLinearContext, resolveLinearConfig } from './linear-context.mjs'
import { gatherGoogleSpecs } from './google-docs.mjs'

async function linearTaskContext({ identifier, env, fetchImpl, log }) {
  const config = resolveLinearConfig(env)
  const linear = await gatherLinearContext({ identifier, config, fetchImpl, log })
  if (!linear) return null
  const sources = [
    linear.issue.description,
    linear.parent?.description,
    linear.project?.description,
    linear.project?.content,
    ...(linear.project?.documents ?? []).map((document) => document.content),
    ...linear.attachments.map((attachment) => attachment.url),
  ].filter(Boolean)
  const specs = await gatherGoogleSpecs({ descriptions: sources, saKey: env.GOOGLE_SA_KEY, fetchImpl, log })
  return formatTaskContext({ ...linear, specs, maxFieldChars: config.maxFieldChars })
}

export async function resolveTaskContext({
  env = process.env,
  fetchImpl = fetch,
  gatherJira = gatherJiraContext,
  excludePageIds = new Set(),
  confluenceSpentChars = 0,
  log = () => {},
}) {
  const sources = [env.HEAD_REF, env.PR_TITLE]

  const linearKey = extractLinearIdentifier(sources, resolveLinearConfig(env).prefixes)
  if (linearKey) {
    log(`[task-context] Linear key: ${linearKey}`)
    return linearTaskContext({ identifier: linearKey, env, fetchImpl, log })
  }

  const jiraKey = extractIssueKey(sources, env.JIRA_PROJECT_PREFIX || 'DFUSION')
  if (jiraKey) {
    log(`[task-context] Jira key: ${jiraKey}`)
    return gatherJira({ issueKey: jiraKey, config: resolveConfig(env), excludePageIds, confluenceSpentChars, log })
  }

  log('[task-context] no Linear or Jira key in branch/title — skipping task context')
  return null
}

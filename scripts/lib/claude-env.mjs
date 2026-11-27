const CREDENTIALS = ['ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN', 'LINEAR_API_KEY', 'GOOGLE_SA_KEY']

export function claudeEnv(env = process.env) {
  const copy = { ...env }
  for (const key of CREDENTIALS) delete copy[key]
  return copy
}

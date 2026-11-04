#!/usr/bin/env node
/** Command-line entry of the edge worker host installed on a machine other than the router's. */
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { WorkerHost, type WorkerHostOptions } from './worker-host.ts'

const text = (name: string): string | undefined => process.env[name]?.trim() || undefined
const required = (name: string): string => {
  const value = text(name)
  if (!value) { console.error(`dsh-superagent-worker: ${name} is required`); process.exit(2) }
  return value
}
const integer = (name: string, fallback: number): number => {
  const value = text(name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) { console.error(`dsh-superagent-worker: ${name} must be a positive integer`); process.exit(2) }
  return parsed
}
const json = (name: string): Record<string, string> => {
  const value = text(name)
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
  } catch { console.error(`dsh-superagent-worker: ${name} must be a JSON object of strings`); process.exit(2) }
}
const workRoot = required('DSH_SUPERAGENT_EDGE_WORK_ROOT')
if (!isAbsolute(workRoot)) { console.error('dsh-superagent-worker: DSH_SUPERAGENT_EDGE_WORK_ROOT must be an absolute path'); process.exit(2) }
const options: WorkerHostOptions = {
  url: required('DSH_SUPERAGENT_EDGE_URL'),
  token: required('DSH_SUPERAGENT_EDGE_TOKEN'),
  workRoot,
  name: text('DSH_SUPERAGENT_EDGE_NAME') ?? hostname(),
  kind: (text('DSH_SUPERAGENT_EDGE_KIND') as WorkerHostOptions['kind']) ?? 'byom',
  labels: json('DSH_SUPERAGENT_EDGE_LABELS'),
  capabilities: (text('DSH_SUPERAGENT_EDGE_CAPABILITIES') ?? '').split(',').map(value => value.trim()).filter(Boolean),
  capacity: integer('DSH_SUPERAGENT_EDGE_CAPACITY', 1),
  version: text('DSH_SUPERAGENT_EDGE_VERSION') ?? '',
  dsh: { command: text('DSH_SUPERAGENT_EDGE_DSH') ?? 'dsh', profile: text('DSH_SUPERAGENT_EDGE_PROFILE') ?? 'headless',
    home: text('DSH_SUPERAGENT_EDGE_DSH_HOME') ?? join(workRoot, '.dsh') },
  log: message => console.error(`[worker-host] ${message}`),
}
const controller = new AbortController()
const stop = (signal: string): void => { console.error(`[worker-host] ${signal}: shutting down`); controller.abort() }
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
const host = new WorkerHost(options)
host.start(controller.signal).then(() => process.exit(0), error => {
  console.error(`[worker-host] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
host.ready.then(environment => console.error(`[worker-host] registered ${environment.id} (${environment.name}) with ${options.url}`),
  () => { /* start() reports the registration failure */ })

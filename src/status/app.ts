/**
 * Browser app of the read-only `/status` surface, shared by phone and desktop installs.
 *
 * It is a standalone single-page app (no DSH shell, no React) so the phone loads only what it needs. Data comes from
 * the authenticated `/status/api` routes; the last summary is kept in localStorage so an offline app can show a
 * clearly labelled snapshot instead of a blank screen. There are no write controls here: the app only links back to
 * Feishu, GitHub or the management panel for actions.
 */
import type { DeviceView } from '../app/devices.ts'
import type { StatusActivity, StatusSummary, StatusTicket, StatusTickets } from '../app/status.ts'

type Language = 'zh' | 'en'
const LANGUAGE: Language = navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
const TEXT = {
  overview: ['概览', 'Overview'], tickets: ['工单', 'Tickets'], activity: ['活动', 'Activity'], setup: ['配对', 'Pairing'],
  refresh: ['刷新', 'Refresh'], updated: ['截至 {time}', 'As of {time}'], loading: ['正在读取…', 'Loading…'],
  retry: ['重试', 'Retry'], offline: ['离线，显示 {time} 的最近快照', 'Offline; showing the snapshot from {time}'],
  offlineNote: ['只读快照，操作请回 Web 面板或飞书', 'Read-only snapshot; use the Web panel or Feishu to act'],
  person: ['需要你', 'Needs you'], noSources: ['没有来源', 'No sources'], pausedNote: ['执行器已暂停', 'Executor paused'],
  codeExpired: ['配对码已过期，请重新生成', 'The pairing code expired; generate a new one'],
  rateLimited: ['尝试次数过多，请稍后再试', 'Too many attempts; wait a minute'],
  noPerson: ['现在没有需要你处理的事', 'Nothing needs you right now'],
  problems: ['问题', 'Problems'], noProblems: ['没有发现需要处理的问题', 'No problems need attention'],
  run: ['运行', 'Running'], executor: ['执行器', 'Executor'], running: ['执行中', 'Running'], queued: ['排队', 'Queued'],
  idle: ['空闲', 'Idle'], flow: ['最近 24 小时', 'Last 24 hours'], received: ['收到', 'Received'],
  accepted: ['接受', 'Accepted'], dropped: ['丢弃', 'Dropped'], sources: ['来源', 'Sources'],
  noTickets: ['没有工单', 'No tickets'], noActivity: ['最近没有决策', 'No recent decisions'],
  ticket: ['工单', 'Ticket'], stage: ['阶段', 'Stage'], updatedAt: ['更新于 {time}', 'Updated {time}'],
  source: ['来源', 'Source'], threads: ['会话', 'Threads'], decision: ['决策', 'Decision'], assignments: ['执行记录', 'Assignments'],
  inputs: ['输入', 'Inputs'], report: ['报告', 'Report'], noReport: ['还没有报告', 'No report yet'],
  openPanel: ['在 Web 面板处理', 'Open the Web panel'], openSource: ['打开来源', 'Open source'],
  pairTitle: ['配对此设备', 'Pair this device'], pairIntro: ['在运行 Superagent 的 Mac 上打开 /status/setup，生成一次性配对码，然后在此输入。',
    'On the Mac that runs Superagent, open /status/setup to generate a one-time pairing code, then enter it here.'],
  pairCode: ['配对码', 'Pairing code'], pair: ['配对', 'Pair'], pairing: ['正在配对…', 'Pairing…'],
  pairFailed: ['配对失败：{reason}', 'Pairing failed: {reason}'], invalidCode: ['配对码无效或已过期', 'The pairing code is invalid or expired'],
  unpaired: ['此设备还未配对。', 'This device is not paired yet.'], goPair: ['去配对', 'Pair this device'],
  remoteOff: ['远程访问未开启。请在主机配置 status.publicUrl 后重试。', 'Remote access is off. Configure status.publicUrl on the Host and retry.'],
  httpsNeeded: ['远程访问需要 HTTPS。请通过 TLS 隧道访问 status.publicUrl。', 'Remote access needs HTTPS. Reach status.publicUrl through a TLS tunnel.'],
  localOnly: ['配对与设备管理只能在运行 Superagent 的电脑上进行。', 'Pairing and device management happen on the computer that runs Superagent.'],
  setupTitle: ['手机与桌面访问', 'Phone and desktop access'], setupYes: ['已开启，状态页地址：', 'On. The status page is at:'],
  setupNo: ['未开启。在插件配置中打开 status.enabled，并设置 status.publicUrl 后重启。',
    'Off. Set status.enabled and status.publicUrl in the plugin configuration, then restart.'],
  codeTitle: ['一次性配对码', 'One-time pairing code'], codeHint: ['60 秒内有效，只能使用一次。在手机或另一台电脑打开配对页并输入。',
    'Valid for 60 seconds, once. Open the pairing page on a phone or another computer and enter it.'],
  makeCode: ['生成配对码', 'Generate code'], codeReady: ['配对码 {code}，{seconds} 秒后过期。', 'Code {code}, expires in {seconds}s.'],
  devices: ['已配对设备', 'Paired devices'], noDevices: ['还没有配对设备', 'No paired devices'],
  revoke: ['撤销', 'Revoke'], revokeAll: ['全部撤销', 'Revoke all'], revoked: ['已撤销', 'Revoked'],
  deviceSeen: ['最后活跃 {time}', 'Last seen {time}'], expires: ['{date} 过期', 'Expires {date}'],
  copy: ['复制', 'Copy'], copied: ['已复制', 'Copied'],
  deviceLimit: ['设备数量已达上限，请先撤销一个设备。', 'Device limit reached; revoke one first.'],
  stageAnswer: ['等待回答', 'Waiting for answer'], stageReview: ['等待验收', 'Waiting for review'],
  stageDelivery: ['投递失败', 'Delivery failed'], stageBlocked: ['被阻塞', 'Blocked'], stageFailed: ['失败', 'Failed'],
  stageQueued: ['排队中', 'Queued'], stageWorking: ['执行中', 'Working'], stageIdle: ['空闲', 'Idle'], stageEnded: ['已结束', 'Ended'],
  decisionAccept: ['接单', 'Accept'], decisionReopen: ['续做', 'Reopen'], decisionStop: ['停止', 'Stop'],
  decisionIgnore: ['忽略', 'Ignore'], decisionUnavailable: ['未完成', 'Unavailable'], decisionWouldAccept: ['本可接单', 'Would accept'],
  filtersOpen: ['全部', 'All'], filtersPerson: ['需要你', 'Needs you'], filtersWorking: ['执行中', 'Working'],
  filtersIdle: ['空闲', 'Idle'], filtersEnded: ['已结束', 'Ended'],
  loadMore: ['加载更多', 'Load more'], back: ['返回', 'Back'], notFound: ['页面不存在', 'Page not found'],
  retryAfter: ['请求失败（{status}），请稍后重试。', 'Request failed ({status}); retry shortly.'],
  unknownError: ['无法连接服务。', 'Cannot reach the service.'],
  noInputs: ['没有输入', 'No inputs'], noThreads: ['没有关联会话', 'No threads'], noChannels: ['没有来源链接', 'No links'],
  setupLocalOnly: ['当前仅本机可访问。要在手机上查看，请在插件配置中设置 status.publicUrl 后重启。',
    'Reachable on this machine only. To view it on a phone, set status.publicUrl in the plugin configuration and restart.'],
  'state.ready': ['正常', 'Ready'], 'state.starting': ['启动中', 'Starting'], 'state.paused': ['已暂停', 'Paused'],
  'state.off': ['已关闭', 'Off'], 'state.error': ['异常', 'Error'], 'state.setup': ['待配置', 'Needs setup'], 'state.missing': ['未安装', 'Not installed'],
  'assignment.pending': ['等待执行', 'Pending'], 'assignment.running': ['执行中', 'Running'], 'assignment.ended': ['已结束', 'Ended'],
  'report.progress': ['进行中', 'Progress'], 'report.waiting': ['等待指令', 'Waiting'], 'report.ready': ['已完成', 'Ready'],
  'report.blocked': ['被阻塞', 'Blocked'], 'report.failed': ['失败', 'Failed'], 'report.dropped': ['已放弃', 'Dropped'],
  'thread.error': ['异常', 'Error'], 'thread.evaluating': ['评估中', 'Evaluating'], 'thread.queued': ['排队中', 'Queued'],
  'thread.subscribed': ['已订阅', 'Subscribed'], 'thread.dormant': ['休眠', 'Dormant'], 'thread.unsubscribed': ['已退订', 'Unsubscribed'],
} as const
type TextKey = keyof typeof TEXT
function t(key: TextKey, values: Record<string, string | number> = {}): string {
  return (TEXT[key][LANGUAGE === 'zh' ? 0 : 1] as string).replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ''))
}
const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const pad = (value: number): string => String(value).padStart(2, '0')
const clock = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const dateText = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return '—'
  const minutes = Math.floor(ms / 60_000)
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}
interface ApiFailure { status: number; code?: string; message: string }
const isFailure = (value: unknown): value is ApiFailure => !!value && typeof value === 'object' && 'status' in value
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init,
    headers: { 'x-status-request': '1', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    let body: { error?: string; code?: string } = {}
    try { body = await response.json() as typeof body } catch { /* A non-JSON failure still reports its status. */ }
    throw { status: response.status, code: body.code, message: body.error ?? t('retryAfter', { status: response.status }) } satisfies ApiFailure
  }
  return await response.json() as T
}
const channel = (label: { zh: string; en: string }): string => LANGUAGE === 'zh' ? label.zh : label.en
function stageText(item: { stage?: string; action?: string; ended?: unknown }): string {
  const stage = item.ended ? 'ended' : item.stage ?? 'working'
  if (stage === 'person') {
    const action = item.action
    return action === 'answer' ? t('stageAnswer') : action === 'review' ? t('stageReview') : action === 'delivery' ? t('stageDelivery')
      : action === 'blocked' ? t('stageBlocked') : action === 'failed' ? t('stageFailed') : t('stageBlocked')
  }
  if (stage === 'working') return item.action === 'queued' ? t('stageQueued') : t('stageWorking')
  return stage === 'idle' ? t('stageIdle') : t('stageEnded')
}
const domainText = (prefix: string, value: string | undefined, fallback = '—'): string => {
  const key = `${prefix}.${value}` as TextKey
  return key in TEXT ? t(key) : fallback
}
const outcomeText = (outcome: string): string => ({
  accept: t('decisionAccept'), reopen: t('decisionReopen'), stop: t('decisionStop'), ignore: t('decisionIgnore'),
  unavailable: t('decisionUnavailable'), wouldAccept: t('decisionWouldAccept'),
} as Record<string, string>)[outcome] ?? outcome
const dotState = (state: string | undefined): string => state === 'attention' ? 'attention' : state === 'offline' ? 'offline' : 'ok'

const SNAPSHOT_KEY = 'dsh-superagent-status-snapshot'
interface Snapshot { at: string; summary: StatusSummary }
function readSnapshot(): Snapshot | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? '') as Snapshot
    return value?.summary ? value : undefined
  } catch { return undefined }
}
/** Strip message bodies and health details from a summary before it is kept offline; titles, stages and counts stay. */
function forCache(summary: StatusSummary): StatusSummary {
  const copy = structuredClone(summary)
  copy.overview.person = copy.overview.person.map(ticket => ({ ...ticket, note: undefined,
    attention: ticket.attention ? { ...ticket.attention, question: '' } : undefined }))
  copy.overview.problems = copy.overview.problems.map(problem => ({ kind: problem.kind }) as StatusSummary['overview']['problems'][number])
  copy.sources = copy.sources.map(source => ({ ...source, health: source.health.map(part => ({ ...part, detail: '' })) }))
  return copy
}
function writeSnapshot(summary: StatusSummary): void {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: summary.asOf, summary: forCache(summary) })) } catch { /* Storage may be full or blocked. */ }
}
function clearSnapshot(): void {
  try { localStorage.removeItem(SNAPSHOT_KEY) } catch { /* Nothing to clear. */ }
}

let latestSummary: StatusSummary | undefined
let offline = false

/** One-page shell: header status, an optional offline banner, the routed page, and the bottom navigation. */
function layout(active: 'overview' | 'tickets' | 'activity' | 'setup' | 'pair' | 'detail', body: string, extra = ''): string {
  const summary = latestSummary
  const label = summary?.instance.label ?? 'Superagent'
  const time = summary ? clock(summary.asOf) : '—'
  const state = offline ? 'offline' : dotState(summary?.health.state)
  const nav = ([['overview', t('overview'), '/status/'], ['tickets', t('tickets'), '/status/tickets'],
    ['activity', t('activity'), '/status/activity'], ['setup', t('setup'), '/status/setup']] as const)
    .map(([key, text, href]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${escapeHtml(text)}</a>`).join('')
  return `<header class="top">
  <div class="brand"><span class="dot ${escapeHtml(state)}" aria-hidden="true"></span><strong>${escapeHtml(label)}</strong></div>
  <div class="meta"><span>${escapeHtml(t('updated', { time }))}</span><button type="button" data-refresh>${escapeHtml(t('refresh'))}</button></div>
</header>
${offline ? `<div class="banner" role="status">${escapeHtml(t('offline', { time }))} · ${escapeHtml(t('offlineNote'))}</div>` : ''}
<main>${extra}${body}</main>
<nav class="bottom" aria-label="Sections">${nav}</nav>`
}
function errorPage(error: unknown): string {
  if (isFailure(error)) {
    if (error.status === 401) return `<div class="card"><h2>${escapeHtml(t('unpaired'))}</h2><p class="hint">${escapeHtml(error.message)}</p>
      <p><a class="chip" href="/status/pair">${escapeHtml(t('goPair'))}</a></p></div>`
    if (error.status === 403 && (error.code === 'remoteDisabled' || error.code === 'httpsRequired' || error.code === 'untrustedHost'))
      return `<div class="card"><p class="error">${escapeHtml(error.code === 'httpsRequired' ? t('httpsNeeded') : t('remoteOff'))}</p></div>`
    return `<div class="card"><p class="error">${escapeHtml(error.message)}</p><p><button type="button" data-refresh>${escapeHtml(t('retry'))}</button></p></div>`
  }
  return `<div class="card"><p class="error">${escapeHtml(t('unknownError'))}</p><p><button type="button" data-refresh>${escapeHtml(t('retry'))}</button></p></div>`
}

function ticketRow(ticket: StatusTickets['items'][number]): string {
  const note = ticket.note ? `<div class="row-meta">${escapeHtml(ticket.note.text)}</div>` : ''
  return `<a class="row" href="/status/tickets/${encodeURIComponent(ticket.id)}">
    <div class="row-title">${escapeHtml(ticket.title)}</div>
    <div class="row-meta"><span class="tag">${escapeHtml(stageText(ticket))}</span><span>${escapeHtml(ticket.id)}</span>
      ${ticket.updatedAt ? `<span>${escapeHtml(t('updatedAt', { time: clock(ticket.updatedAt) }))}</span>` : ''}</div>${note}</a>`
}
type Problem = StatusSummary['overview']['problems'][number]
/** Short title of one overview problem, without any message body. */
function problemTitle(problem: Problem): string {
  switch (problem.kind) {
    case 'setup': return `setup: ${problem.code}`
    case 'source-error': return `${problem.source.id}: ${problem.source.health.state}`
    case 'runtime-error': return `${problem.name}: ${problem.detail}`
    case 'outgoing': return `outgoing: ${problem.outgoing.error}`
    case 'eval-overdue': return `${problem.thread.title}`
    case 'eval-unavailable': return `${problem.thread.title}`
    default: return problem.kind
  }
}
function problems(list: Problem[]): string {
  if (!list.length) return `<p class="empty">${escapeHtml(t('noProblems'))}</p>`
  return `<ul class="list">${list.map(problem => `<li class="row"><div class="row-title">${escapeHtml(problemTitle(problem))}</div>
    <div class="row-meta"><span class="tag warn">${escapeHtml(problem.kind)}</span></div></li>`).join('')}</ul>`
}
function sourceRows(list: StatusSummary['sources']): string {
  if (!list.length) return `<p class="empty">${escapeHtml(t('noSources'))}</p>`
  return `<ul class="list">${list.map(source => {
    const bad = source.health.filter(part => part.state === 'error').length
    return `<li class="row"><div class="row-title">${escapeHtml(channel(source.title))} <span class="tag ${source.state === 'ready' ? 'ok' : source.state === 'error' ? 'error' : 'warn'}">${escapeHtml(domainText('state', source.state))}</span></div>
      <div class="row-meta"><span>${escapeHtml(t('received'))} ${source.stats.received}</span><span>${escapeHtml(source.id)}</span>
      ${bad ? `<span class="error">${bad} error</span>` : ''}</div></li>`
  }).join('')}</ul>`
}
function overviewPage(summary: StatusSummary, offlineSnapshot = false): string {
  const person = summary.overview.person
  const executor = summary.overview.executor
  const flow = summary.overview.flow
  return layout('overview', `<div class="grid">
    <section class="card wide" aria-labelledby="person-title"><h2 id="person-title">${escapeHtml(t('person'))} (${person.length})</h2>
      ${summary.paused ? `<p class="tag warn">${escapeHtml(t('pausedNote'))}</p>` : ''}
      ${person.length ? `<ul class="list">${person.map(ticketRow).join('')}</ul>` : `<p class="empty">${escapeHtml(t('noPerson'))}</p>`}
    </section>
    <section class="card" aria-labelledby="problems-title"><h2 id="problems-title">${escapeHtml(t('problems'))} (${summary.overview.problems.length})</h2>
      ${problems(summary.overview.problems)}</section>
    <section class="card" aria-labelledby="run-title"><h2 id="run-title">${escapeHtml(t('run'))}</h2>
      <div class="metrics">
        <div class="metric"><b>${executor.running}</b><span>${escapeHtml(t('running'))}</span></div>
        <div class="metric"><b>${executor.queued}</b><span>${escapeHtml(t('queued'))}</span></div>
        <div class="metric"><b>${executor.idle}</b><span>${escapeHtml(t('idle'))}</span></div>
        <div class="metric"><b>${flow.accepted}</b><span>${escapeHtml(t('accepted'))} / ${LANGUAGE === 'zh' ? '24 小时' : '24h'}</span></div>
      </div>
      <p class="hint">${escapeHtml(t('flow'))}: ${escapeHtml(t('received'))} ${flow.received} · ${escapeHtml(t('dropped'))} ${flow.dropped}</p>
    </section>
    <section class="card wide" aria-labelledby="sources-title"><h2 id="sources-title">${escapeHtml(t('sources'))}</h2>
      ${sourceRows(summary.sources)}</section>
  </div>`, offlineSnapshot ? `<p class="hint">${escapeHtml(t('offlineNote'))}</p>` : '')
}
function ticketsPage(result: StatusTickets, stage: string): string {
  const filters = ([['open', t('filtersOpen')], ['person', t('filtersPerson')], ['working', t('filtersWorking')],
    ['idle', t('filtersIdle')], ['ended', t('filtersEnded')]] as const)
    .map(([value, text]) => `<a class="chip" aria-pressed="${value === stage}" href="/status/tickets?state=${value}">${escapeHtml(text)}</a>`).join('')
  const more = result.next_offset === null ? '' : `<p><a class="chip" href="/status/tickets?state=${encodeURIComponent(stage)}&offset=${result.next_offset}">${escapeHtml(t('loadMore'))}</a></p>`
  return layout('tickets', `<div class="chips" role="group" aria-label="${escapeHtml(t('tickets'))}">${filters}</div>
    ${result.items.length ? `<ul class="list">${result.items.map(ticketRow).join('')}</ul>` : `<p class="empty">${escapeHtml(t('noTickets'))}</p>`}${more}`)
}
function reportBlock(assignment: StatusTicket['assignments'][number]): string {
  const report = assignment.report
  return `<li class="row"><div class="row-meta"><span class="tag">${escapeHtml(domainText('assignment', assignment.state))}</span>
    ${report ? `<span>${escapeHtml(domainText('report', report.state))}</span><span>${escapeHtml(clock(report.at))}</span>` : ''}</div>
    ${report?.summary ? `<div class="prose">${escapeHtml(report.summary)}</div>` : `<div class="hint">${escapeHtml(t('noReport'))}</div>`}</li>`
}
function detailPage(ticket: StatusTicket): string {
  const threads = ticket.threads.map(thread => `<li class="row"><div class="row-title">${escapeHtml(thread.title)}</div>
    <div class="row-meta"><span>${escapeHtml(thread.source)}</span><span>${escapeHtml(domainText('thread', thread.stage))}</span>
    ${thread.url ? `<a href="${escapeHtml(thread.url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(t('openSource'))}</a>` : ''}</div></li>`).join('')
  const channels = ticket.channels.map(item => `<li class="row"><div class="row-title">${escapeHtml(channel(item.label))}</div>
    <div class="row-meta"><span>${escapeHtml(item.source)}</span>${item.url ? `<a href="${escapeHtml(item.url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(t('openSource'))}</a>` : ''}</div></li>`).join('')
  const decision = ticket.decision ? `<section class="card wide"><h2>${escapeHtml(t('decision'))}</h2>
    <p><span class="tag">${escapeHtml(outcomeText(ticket.decision.outcome))}</span> <span class="muted">${escapeHtml(clock(ticket.decision.at))}</span></p>
    ${typeof ticket.decision.reason === 'string' ? `<p class="prose">${escapeHtml(ticket.decision.reason)}</p>` : ''}</section>` : ''
  const inputs = ticket.inputs.map(input => `<li class="row"><div class="row-meta"><span class="tag">${escapeHtml(input.kind)}</span>
    ${input.trigger ? `<span>${escapeHtml(input.trigger.actor)}</span>` : ''}</div>
    <div class="prose">${escapeHtml(input.text ?? input.trigger?.preview ?? '')}</div></li>`).join('')
  return layout('detail', `<p><a href="/status/tickets">← ${escapeHtml(t('tickets'))}</a></p>
    <div class="grid">
      <section class="card wide"><h1>${escapeHtml(ticket.title)}</h1>
        <p class="row-meta"><span class="tag">${escapeHtml(stageText(ticket))}</span><span class="mono">${escapeHtml(ticket.id)}</span>
          <span>${escapeHtml(t('updatedAt', { time: clock(ticket.updatedAt) }))}</span></p>
        ${ticket.note ? `<p class="prose">${escapeHtml(ticket.note.text)}</p>` : ''}
        <p class="hint">${escapeHtml(t('offlineNote'))}</p></section>
      ${decision}
      <section class="card"><h2>${escapeHtml(t('assignments'))} (${ticket.assignments.length})</h2>
        ${ticket.assignments.length ? `<ul class="list">${ticket.assignments.map(reportBlock).join('')}</ul>` : `<p class="empty">${escapeHtml(t('noReport'))}</p>`}</section>
      <section class="card"><h2>${escapeHtml(t('inputs'))} (${ticket.inputs.length})</h2>
        ${inputs ? `<ul class="list">${inputs}</ul>` : `<p class="empty">${escapeHtml(t('noInputs'))}</p>`}</section>
      <section class="card wide"><h2>${escapeHtml(t('threads'))}</h2>${threads ? `<ul class="list">${threads}</ul>` : `<p class="empty">${escapeHtml(t('noThreads'))}</p>`}</section>
      <section class="card wide"><h2>${escapeHtml(t('source'))}</h2>${channels ? `<ul class="list">${channels}</ul>` : `<p class="empty">${escapeHtml(t('noChannels'))}</p>`}</section>
    </div>`)
}
function activityPage(result: StatusActivity): string {
  if (!result.items.length) return layout('activity', `<p class="empty">${escapeHtml(t('noActivity'))}</p>`)
  return layout('activity', `<ul class="list">${result.items.map(decision => `<li class="row">
    <div class="row-title">${escapeHtml(decision.ticketTitle ?? decision.threadTitle ?? decision.thread)}</div>
    <div class="row-meta"><span class="tag">${escapeHtml(outcomeText(decision.outcome))}</span><span>${escapeHtml(clock(decision.at))}</span>
      ${decision.preview ? `<span>${escapeHtml(decision.preview)}</span>` : ''}</div></li>`).join('')}</ul>`)
}
function pairPage(): string {
  return layout('pair', `<section class="pair card"><h1>${escapeHtml(t('pairTitle'))}</h1>
    <p class="hint">${escapeHtml(t('pairIntro'))}</p>
    <form data-pair><label for="pair-code">${escapeHtml(t('pairCode'))}</label>
      <input id="pair-code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="200" required>
      <button class="primary" type="submit">${escapeHtml(t('pair'))}</button>
      <p class="error" data-pair-error role="alert" hidden></p></form></section>`)
}
function setupPage(view: { enabled: boolean; publicUrl: string; url: string; devices: DeviceView[]; maxDevices: number }): string {
  const devices = view.devices.length ? `<ul class="list">${view.devices.map(device => `<li class="row device">
      <div><div class="row-title">${escapeHtml(device.label)}</div>
      <div class="row-meta"><span>${escapeHtml(t('deviceSeen', { time: clock(device.lastSeenAt) }))}</span>
      <span>${escapeHtml(t('expires', { date: dateText(device.expiresAt) }))}</span></div></div>
      <button type="button" data-revoke="${escapeHtml(device.id)}">${escapeHtml(t('revoke'))}</button></li>`).join('')}</ul>`
    : `<p class="empty">${escapeHtml(t('noDevices'))}</p>`
  return layout('setup', `<div class="grid">
    <section class="card wide"><h1>${escapeHtml(t('setupTitle'))}</h1>
      <p class="${view.enabled ? 'hint' : 'error'}">${escapeHtml(view.enabled ? t('setupYes') : t('setupNo'))}</p>
      ${view.enabled ? `<p class="setup-url"><a class="mono" href="${escapeHtml(view.url)}">${escapeHtml(view.url)}</a>
        <button type="button" data-copy="${escapeHtml(view.url)}">${escapeHtml(t('copy'))}</button></p>
        ${view.publicUrl ? '' : `<p class="hint">${escapeHtml(t('setupLocalOnly'))}</p>`}` : ''}
      <h2>${escapeHtml(t('codeTitle'))}</h2><p class="hint">${escapeHtml(t('codeHint'))}</p>
      <p><button type="button" class="primary" data-make-code>${escapeHtml(t('makeCode'))}</button></p>
      <p class="mono" data-code role="status"></p></section>
    <section class="card wide"><h2>${escapeHtml(t('devices'))} (${view.devices.length}/${view.maxDevices})</h2>${devices}
      ${view.devices.length ? `<p><button type="button" data-revoke-all>${escapeHtml(t('revokeAll'))}</button></p>` : ''}</section>
  </div>`)
}

async function route(): Promise<string> {
  const path = location.pathname.replace(/^\/status\/?/, '').replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'pair') return pairPage()
  if (segments[0] === 'setup') {
    try { return setupPage(await api<{ enabled: boolean; publicUrl: string; url: string; devices: DeviceView[]; maxDevices: number }>('/status/api/setup')) }
    catch (error) {
      if (isFailure(error) && error.status === 403) return layout('setup', `<div class="card"><p>${escapeHtml(t('localOnly'))}</p></div>`)
      return layout('setup', errorPage(error))
    }
  }
  if (segments[0] === 'tickets') {
    if (segments[1]) return detailPage(await api<StatusTicket>(`/status/api/tickets/${encodeURIComponent(segments[1])}`))
    const stage = new URLSearchParams(location.search).get('state') ?? 'open'
    const offset = Number.parseInt(new URLSearchParams(location.search).get('offset') ?? '', 10) || 0
    return ticketsPage(await api<StatusTickets>(`/status/api/tickets?state=${encodeURIComponent(stage)}&offset=${offset}`), stage)
  }
  if (segments[0] === 'activity') return activityPage(await api<StatusActivity>('/status/api/activity?limit=30'))
  if (segments.length) return layout('overview', `<div class="card"><h1>${escapeHtml(t('notFound'))}</h1></div>`)
  offline = false
  try {
    const summary = await api<StatusSummary>('/status/api/summary')
    latestSummary = summary
    writeSnapshot(summary)
    return overviewPage(summary)
  } catch (error) {
    if (isFailure(error)) throw error
    const snapshot = readSnapshot()
    if (!snapshot) throw error
    offline = true
    latestSummary = snapshot.summary
    return overviewPage(snapshot.summary, true)
  }
}

let rendering = false
async function render(): Promise<void> {
  if (rendering) return
  rendering = true
  const root = document.getElementById('root')!
  try {
    root.innerHTML = layout('overview', `<p class="hint">${escapeHtml(t('loading'))}</p>`)
    // A deep link opens without the overview request; read the summary once so the header still names the instance and time.
    if (!latestSummary && location.pathname !== '/status/' && !offline) {
      try { latestSummary = await api<StatusSummary>('/status/api/summary'); writeSnapshot(latestSummary) } catch { /* The routed page reports its own failure. */ }
    }
    const html = await route()
    if (html) root.innerHTML = html
    bind(root)
  } catch (error) {
    root.innerHTML = layout('overview', errorPage(error))
    bind(root)
  } finally { rendering = false }
}
function bind(root: HTMLElement): void {
  root.querySelectorAll('[data-refresh]').forEach(button => button.addEventListener('click', () => { void render() }))
  root.querySelector('[data-pair]')?.addEventListener('submit', event => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    const code = String(new FormData(form).get('code') ?? '').trim()
    const error = form.querySelector<HTMLElement>('[data-pair-error]')!
    error.hidden = true
    form.querySelector('button')!.setAttribute('disabled', '')
    api('/status/api/pair', { method: 'POST', body: JSON.stringify({ code }) }).then(() => {
      latestSummary = undefined; offline = false
      history.replaceState(undefined, '', '/status/')
      void render()
    }).catch((failure: unknown) => {
      error.hidden = false
      const reason = isFailure(failure) ? failure.code === 'expired' ? t('codeExpired') : failure.code === 'rateLimited' ? t('rateLimited')
        : failure.code === 'limit' ? t('deviceLimit') : t('invalidCode') : t('invalidCode')
      error.textContent = t('pairFailed', { reason })
      form.querySelector('button')!.removeAttribute('disabled')
    })
  })
  root.querySelector('[data-make-code]')?.addEventListener('click', () => {
    api<{ code: string; expiresAt: string }>('/status/api/devices/code', { method: 'POST' }).then(result => {
      const target = root.querySelector<HTMLElement>('[data-code]')
      if (target) target.textContent = t('codeReady', { code: result.code, seconds: Math.max(0, Math.round((Date.parse(result.expiresAt) - Date.now()) / 1000)) })
    }).catch(error => {
      const target = root.querySelector<HTMLElement>('[data-code]')
      if (target) target.textContent = isFailure(error) && error.status === 409 ? t('deviceLimit') : t('unknownError')
    })
  })
  root.querySelectorAll<HTMLElement>('[data-copy]').forEach(button => button.addEventListener('click', () => {
    const value = button.dataset.copy ?? ''
    void navigator.clipboard?.writeText(value).then(() => { button.textContent = t('copied') })
  }))
  const revoke = (id: string) => api(`/status/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => render())
  root.querySelectorAll<HTMLElement>('[data-revoke]').forEach(button => button.addEventListener('click', () => { void revoke(button.dataset.revoke!) }))
  root.querySelector<HTMLElement>('[data-revoke-all]')?.addEventListener('click', () => {
    root.querySelectorAll<HTMLElement>('[data-revoke]').forEach(button => { void revoke(button.dataset.revoke!) })
  })
  // Pairing from a shared link: a #code= fragment is read locally and submitted once; it never reaches the server as a URL.
  if (location.pathname.replace(/\/+$/, '') === '/status/pair') {
    const code = new URLSearchParams(location.hash.slice(1)).get('code')
    if (code) {
      history.replaceState(undefined, '', '/status/pair')
      const input = root.querySelector<HTMLInputElement>('#pair-code')
      if (input) { input.value = code; root.querySelector<HTMLFormElement>('[data-pair]')?.requestSubmit() }
    }
  }
}
// Same-origin links inside /status navigate without a full reload; everything else loads normally.
document.addEventListener('click', event => {
  const link = (event.target as Element | null)?.closest?.('a')
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target) return
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin || !url.pathname.startsWith('/status/')) return
  event.preventDefault()
  history.pushState(undefined, '', url.pathname + url.search)
  void render()
})
window.addEventListener('popstate', () => { void render() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !location.pathname.includes('/pair')) void render() })
setInterval(() => {
  if (document.visibilityState === 'visible' && !location.pathname.includes('/pair') && !location.pathname.includes('/setup')) void render()
}, 15_000)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/status/sw.js').catch(() => { /* The app still works without offline caching. */ })
void render()

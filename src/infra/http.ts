/** Minimal JSON-over-HTTP client for Sources that call a platform API directly (WeCom and DingTalk). */
export interface HttpOptions {
  method?: 'GET' | 'POST'
  /** JSON request body; sent with `content-type: application/json`. */
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}
/** A failed platform call with the HTTP status and the platform's own error code, when it reported one. */
export class HttpError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message) }
}
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 1_048_576
/** Reads the platform error out of a response body without echoing request details. */
function failure(status: number, body: unknown): HttpError {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const message = typeof record.message === 'string' ? record.message
    : typeof record.errmsg === 'string' ? record.errmsg
    : typeof record.error_description === 'string' ? record.error_description
    : `HTTP ${status}`
  const code = record.code ?? record.errcode ?? record.error_code
  return new HttpError(String(message).slice(0, 1000), status, code === undefined ? undefined : String(code))
}
/**
 * Calls a JSON API with a bounded timeout and response size, and throws `HttpError` for transport failures,
 * non-2xx answers and unreadable bodies. A platform may answer 200 with its own error code; callers check that.
 */
export async function requestJson(url: string, options: HttpOptions = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), signal,
      headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  } catch (error) {
    if (timeout.aborted) throw new HttpError(`The request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`)
    if (options.signal?.aborted) throw error
    throw new HttpError(`The request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new HttpError(`The response exceeds ${MAX_RESPONSE_BYTES} bytes`, response.status)
  let text: string
  try { text = await response.text() }
  catch (error) { throw new HttpError(`The response could not be read: ${error instanceof Error ? error.message : String(error)}`, response.status) }
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new HttpError(`The response exceeds ${MAX_RESPONSE_BYTES} bytes`, response.status)
  let body: unknown
  try { body = text ? JSON.parse(text) : undefined }
  catch { throw new HttpError(response.ok ? 'The response is not JSON' : `HTTP ${response.status}`, response.status) }
  if (!response.ok) throw failure(response.status, body)
  return body
}

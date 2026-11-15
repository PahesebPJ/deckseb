import { constants } from 'node:fs'
import { type FileHandle, open, realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * The viewer only ever talks to itself (same-origin page) or to the local CLI (Node fetch, which
 * sends no Origin). Anything else reaching the loopback port is a web page trying to use the
 * server as a confused deputy, so these checks reject it before routing.
 */

export const MAX_BODY_BYTES = 5 * 1024 * 1024
export const MAX_PLAN_FILE_BYTES = 5 * 1024 * 1024
export const PLAN_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]']

function allowedHostnames(bindHost: string): Set<string> {
  const names = new Set(LOOPBACK_HOSTNAMES)
  const bound = bindHost.toLowerCase()
  if (bound && bound !== '0.0.0.0' && bound !== '::') {
    names.add(bound.includes(':') && !bound.startsWith('[') ? `[${bound}]` : bound)
  }
  return names
}

/** Rejects DNS-rebinding requests whose Host is an attacker-controlled name. */
export function isAllowedHost(hostHeader: string | undefined, port: number, bindHost = '127.0.0.1'): boolean {
  if (!hostHeader) return false
  const host = hostHeader.trim().toLowerCase()
  for (const name of allowedHostnames(bindHost)) {
    if (host === `${name}:${port}`) return true
  }
  return false
}

/** Same-origin browser requests and Origin-less local clients pass; any foreign or opaque origin fails. */
export function isAllowedOrigin(originHeader: string | undefined, port: number, bindHost = '127.0.0.1'): boolean {
  if (originHeader === undefined) return true
  const origin = originHeader.trim().toLowerCase()
  for (const name of allowedHostnames(bindHost)) {
    if (origin === `http://${name}:${port}`) return true
  }
  return false
}

export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * `<img>`/`<script>` GETs from another site carry no Origin but browsers tag them with
 * Sec-Fetch-Site. Absent (CLI, older browsers), `same-origin` and `none` (typed URL) pass.
 */
export function isAllowedFetchSite(fetchSiteHeader: string | undefined): boolean {
  if (fetchSiteHeader === undefined) return true
  const site = fetchSiteHeader.trim().toLowerCase()
  return site === 'same-origin' || site === 'none'
}

/** Requiring JSON forces a CORS preflight for browsers, which this server never approves. */
export function isJsonContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}

export type PlanFileRead =
  | { ok: true; path: string; content: string }
  | { ok: false; status: number; error: string }

/**
 * Only regular Markdown files of bounded size may be read on behalf of a request. The checks and
 * the read share one file descriptor opened with O_NOFOLLOW, so swapping the file for a symlink
 * after validation (TOCTOU) cannot redirect the read.
 */
export async function readPlanFile(filePath: unknown): Promise<PlanFileRead> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { ok: false, status: 400, error: 'filePath must be a non-empty string' }
  }
  let real: string
  try {
    real = await realpath(path.resolve(filePath))
  } catch {
    return { ok: false, status: 404, error: 'filePath does not exist' }
  }
  // Checked on the resolved target so a `plan.md` symlink to ~/.ssh/id_rsa is still refused.
  if (!PLAN_FILE_EXTENSIONS.has(path.extname(real).toLowerCase())) {
    return { ok: false, status: 403, error: 'Only Markdown plan files (.md, .markdown, .mdx) can be opened' }
  }

  let handle: FileHandle
  try {
    // O_NOFOLLOW does not exist on Windows; there the realpath check above is the guard.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return { ok: false, status: 403, error: 'filePath could not be opened safely' }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      return { ok: false, status: 403, error: 'filePath is not a regular file' }
    }
    if (info.size > MAX_PLAN_FILE_BYTES) {
      return { ok: false, status: 413, error: 'Plan file is too large' }
    }
    // Bounded read: the file may still grow after fstat.
    const buffer = Buffer.alloc(MAX_PLAN_FILE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_PLAN_FILE_BYTES) {
      return { ok: false, status: 413, error: 'Plan file is too large' }
    }
    return { ok: true, path: real, content: buffer.subarray(0, bytesRead).toString('utf8') }
  } finally {
    await handle.close()
  }
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
}

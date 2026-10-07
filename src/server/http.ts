/** Small HTTP helpers shared by the routes. */

import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  readonly status: number;
  /** More for the screen to point at the problem (e.g. which ingredient line). */
  readonly details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, expires: Date, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}

export async function body(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'Too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new HttpError(400, 'Bad JSON.');
}

export function str(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `Missing ${key}.`);
  return v;
}

export function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}


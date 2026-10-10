/**
 * Asking Claude (Anthropic's API) to read something and answer with one tool call: pages (photos,
 * PDFs) and text in, the tool's input back as JSON. The tool is forced, so the answer always has
 * the shape asked for. Used for invoices, OpenTable reports, wine tech sheets and suggestions.
 */

export interface ClaudePage { mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf' | 'text/plain'; data: Buffer }

export interface ClaudeOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  /** Anthropic's API unless set (a stand-in for trying things out locally). */
  baseUrl?: string;
  maxTokens?: number;
}

export interface ClaudeTool { name: string; description: string; input_schema: Record<string, unknown> }

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export class ReaderError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); if (status !== undefined) this.status = status; }
}

export interface ClaudeAnswer<T> { input: T; usage: { input: number; output: number }; model: string }

/** Sends the pages and the prompt; returns what Claude put in the tool call. */
export async function askWithTool<T = any>(pages: readonly ClaudePage[], prompt: string, tool: ClaudeTool, opts: ClaudeOptions, what = 'The reader'): Promise<ClaudeAnswer<T>> {
  const model = opts.model ?? DEFAULT_MODEL;
  // A PDF as a document, a photo as an image, an email's text as text.
  const content: unknown[] = pages.map((p) => p.mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: p.mediaType, data: p.data.toString('base64') } }
    : p.mediaType === 'text/plain' ? { type: 'text', text: p.data.toString('utf8').slice(0, 200_000) }
    : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data.toString('base64') } });
  content.push({ type: 'text', text: prompt });
  const res = await (opts.fetch ?? fetch)(`${opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 8000, tools: [tool], tool_choice: { type: 'tool', name: tool.name }, messages: [{ role: 'user', content }] }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ReaderError(data?.error?.message ?? `${what} answered ${res.status}.`, res.status);
  const call = (data.content ?? []).find((c: any) => c.type === 'tool_use' && c.name === tool.name);
  if (!call?.input) throw new ReaderError(`${what} didn’t send back an answer.`);
  return { input: call.input as T, usage: { input: Number(data.usage?.input_tokens ?? 0), output: Number(data.usage?.output_tokens ?? 0) }, model };
}

/** Where the key and model come from (the environment); tests swap in a pretend fetch. */
export const claudeSettings = {
  apiKey: (): string | undefined => process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  model: (): string | undefined => process.env.ANTHROPIC_MODEL?.trim() || undefined,
  baseUrl: (): string | undefined => process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
};

/** The options to read with now, or undefined when no key is set. */
export function claudeOptions(): ClaudeOptions | undefined {
  const apiKey = claudeSettings.apiKey();
  if (!apiKey) return undefined;
  const model = claudeSettings.model(), baseUrl = claudeSettings.baseUrl();
  return { apiKey, fetch: claudeSettings.fetch as typeof fetch, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) };
}

export const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : undefined);
export const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ''))) ? Number(v.replace(/[$,]/g, '')) : undefined);
export const texts = (v: unknown) => (Array.isArray(v) ? v.map(text).filter((x): x is string => Boolean(x)) : []);

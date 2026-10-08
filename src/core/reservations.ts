/**
 * Tonight's book, from OpenTable: the pre-shift digest email (read by Claude from its printout),
 * the reservations printout, or the CSV export. Each gives tonight's reservations; the digest also
 * knows guests' history (visits last year, last visit, spend per cover) and the team's notes.
 *
 * A reservation lands in a room by its table. A later CSV refreshes times, tables and new bookings;
 * what the digest knew about a guest stays with them by name.
 */

export interface Reservation {
  /** 24-hour "17:15". */
  time: string;
  partySize: number;
  name: string;
  /** "T37", "T36": every table it's on (OpenTable writes "T2+" for pushed-together tables). */
  tables: string[];
  combined?: boolean;
  /** Regulars: OpenTable's VIP / special relationship, and the note that came with it. */
  vip?: boolean;
  vipNote?: string;
  occasions: string[];
  requests?: string;
  notes?: string;
  visitsLastYear?: number;
  lastVisit?: string;
  spendPerCover?: number;
}

export interface Book {
  day?: string;
  /** When OpenTable made the report. */
  asOf?: string;
  covers?: number;
  reservations: Reservation[];
}

/** "5:15 pm" / "5:15 PM" / "17:15" → "17:15". */
export function clock(raw: string): string | undefined {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!m) return undefined;
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** "T2+" → T2, combined; "T37,T36" → both. */
export function tablesOf(raw: string): { tables: string[]; combined: boolean } {
  const parts = raw.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  const combined = parts.some((p) => p.endsWith('+')) || parts.length > 1;
  return { tables: parts.map((p) => p.replace(/\+$/, '')).filter((p) => /^[A-Z]*\d+$/.test(p)), combined };
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** The "NOTES AND TAGS" column: "GUEST REQUESTS: … SEATING PREFERENCES: … SPECIAL EVENTS: Birthday". */
export function notesAndTags(raw: string): Pick<Reservation, 'occasions' | 'requests' | 'vip' | 'vipNote' | 'notes'> {
  const parts = new Map<string, string>();
  const re = /([A-Z][A-Z ]+):/g;
  const marks = [...raw.matchAll(re)].map((m) => ({ label: m[1]!.trim(), at: m.index!, end: m.index! + m[0].length }));
  marks.forEach((m, i) => parts.set(m.label, raw.slice(m.end, marks[i + 1]?.at ?? raw.length).replace(/[\s,]+$/, '').trim()));
  const out: Pick<Reservation, 'occasions' | 'requests' | 'vip' | 'vipNote' | 'notes'> = { occasions: [] };
  const events = parts.get('SPECIAL EVENTS');
  if (events) out.occasions = events.split(/[,·]/).map((s) => s.trim()).filter(Boolean);
  if (parts.get('GUEST REQUESTS')) out.requests = parts.get('GUEST REQUESTS')!;
  const rel = parts.get('SPECIAL RELATIONSHIP');
  if (rel) { out.vip = true; out.vipNote = rel; }
  const general = parts.get('GENERAL NOTES') ?? parts.get('VISIT NOTES');
  if (general) out.notes = general;
  return out;
}

/** OpenTable's CSV export (TIME, PARTY SIZE, GUEST, PHONE, TABLE, NOTES AND TAGS, ...). Phones aren't kept. */
export function readOpenTableCsv(text: string): Book {
  const rows = csvRows(text.replace(/^﻿/, ''));
  const head = (rows.shift() ?? []).map((h) => h.trim().toUpperCase());
  const col = (name: string) => head.indexOf(name);
  const [ti, pi, gi, tbi, ni, si] = ['TIME', 'PARTY SIZE', 'GUEST', 'TABLE', 'NOTES AND TAGS', 'TABLE STATUS'].map(col);
  if (ti! < 0 || gi! < 0) throw new Error('That isn’t an OpenTable reservations export (no TIME and GUEST columns).');
  const reservations: Reservation[] = [];
  for (const r of rows) {
    const time = clock(r[ti!] ?? '');
    const name = (r[gi!] ?? '').trim();
    if (!time || !name) continue;
    if (si! >= 0 && /cancel|no.?show/i.test(r[si!] ?? '')) continue;
    const t = tablesOf(r[tbi!] ?? '');
    reservations.push({ time, partySize: Number(r[pi!]) || 0, name, tables: t.tables, ...(t.combined ? { combined: true } : {}), ...notesAndTags(r[ni!] ?? '') });
  }
  return { reservations, covers: reservations.reduce((a, r) => a + r.partySize, 0) };
}

const nameKey = (n: string) => n.toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/**
 * A later report on top of an earlier one: the later one decides who's coming, when and where;
 * what the earlier one knew about a guest (history, regular, notes) stays with them by name.
 */
export function mergeBooks(earlier: Book | undefined, later: Book): Book {
  if (!earlier) return later;
  const known = new Map(earlier.reservations.map((r) => [nameKey(r.name), r]));
  return {
    ...later,
    reservations: later.reservations.map((r) => {
      const was = known.get(nameKey(r.name));
      if (!was) return r;
      return {
        ...was, ...r,
        occasions: [...new Set([...was.occasions, ...r.occasions])],
        ...(was.vip || r.vip ? { vip: true } : {}),
        ...(r.vipNote ?? was.vipNote ? { vipNote: r.vipNote ?? was.vipNote } : {}),
        ...(r.requests ?? was.requests ? { requests: r.requests ?? was.requests } : {}),
        ...(r.notes ?? was.notes ? { notes: r.notes ?? was.notes } : {}),
      };
    }),
  };
}

/** Seen often enough to count as a regular, without being marked one. */
export const REGULAR_VISITS = 6;

/** What makes a reservation worth a line on the board, and why. */
export function whyNotable(r: Reservation): string[] {
  const why: string[] = [];
  if (r.vip) why.push('regular');
  for (const o of r.occasions) why.push(o.toLowerCase());
  if (r.partySize >= 5) why.push(`party of ${r.partySize}`);
  if (r.requests) why.push('request');
  if (r.notes) why.push('notes');
  if (!r.vip && (r.visitsLastYear ?? 0) >= REGULAR_VISITS) why.push('often here');
  return why;
}

/** The reservations for a set of tables (a room), by time; all of them for the host stand. */
export function forTables(book: Book, tables: readonly string[] | 'all'): Reservation[] {
  const mine = tables === 'all' ? book.reservations : book.reservations.filter((r) => r.tables.some((t) => tables.includes(t)));
  return [...mine].sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
}

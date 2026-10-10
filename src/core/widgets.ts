/**
 * Board widgets: every Service iPad (kitchen or front of house) shows a board built from the same
 * widgets; a manager picks which, in what order and how wide, per post. A post with none chosen
 * shows the defaults for its kind. Pure: the server stores the choice, the page draws each widget.
 */

export const WIDGET_TYPES = ['dough', 'online', 'book', 'sales', 'gelato', 'pairings', 'notes', 'specials', 'new'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type WidgetSize = 'small' | 'wide';

export interface Widget {
  type: WidgetType;
  size: WidgetSize;
  /** Sales counter: the Square category it counts ("Cocktails"). */
  category?: string;
}

export const WIDGET_INFO: Record<WidgetType, { name: string; about: string; size: WidgetSize }> = {
  dough: { name: 'Dough count', about: 'Takeout, dough and gluten-free left, live. The kitchen’s board can change them.', size: 'wide' },
  online: { name: 'Online orders', about: 'On or paused, with big buttons to pause or turn them off for the night.', size: 'small' },
  book: { name: 'Tonight to know', about: 'Allergies, celebrations, regulars and big parties from the OpenTable report.', size: 'wide' },
  sales: { name: 'Sold tonight', about: 'A live count of one Square category tonight, e.g. cocktails.', size: 'small' },
  gelato: { name: 'Gelato flight', about: 'Tonight’s flavors and pan changes.', size: 'small' },
  pairings: { name: 'Find a pairing', about: 'Wine for a dish, or a dish for a wine.', size: 'small' },
  notes: { name: 'From the managers', about: 'Tonight’s notes for this post.', size: 'small' },
  specials: { name: 'Specials', about: 'Tonight’s specials, or what to talk up.', size: 'small' },
  new: { name: 'New on the menu', about: 'New dishes to browse, and the menu quiz.', size: 'small' },
};

const w = (type: WidgetType, size: WidgetSize = WIDGET_INFO[type].size): Widget => ({ type, size });

/** What a post shows until a manager chooses: what each kind of post needs most, first. */
export function defaultWidgets(kind: string): Widget[] {
  switch (kind) {
    case 'kitchen': return [w('dough'), w('online'), w('notes'), w('specials'), w('book')];
    case 'counter': return [w('dough'), w('online'), w('book'), w('gelato'), w('notes'), w('specials'), w('new')];
    case 'host': return [w('dough'), w('online'), w('book'), w('notes'), w('specials'), w('gelato'), w('new')];
    case 'bar': return [w('book'), w('gelato'), w('pairings'), w('notes'), w('specials'), w('new')];
    default: return [w('book'), w('gelato'), w('pairings'), w('notes'), w('specials'), w('new')];
  }
}

/** A manager's list, checked: known widgets only, sizes small or wide, at most 20. Undefined when it isn't a list. */
export function cleanWidgets(v: unknown): Widget[] | undefined {
  if (!Array.isArray(v) || v.length > 20) return undefined;
  const out: Widget[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') return undefined;
    const { type, size, category } = x as Record<string, unknown>;
    if (!WIDGET_TYPES.includes(type as WidgetType)) return undefined;
    const cat = typeof category === 'string' ? category.trim().slice(0, 80) : '';
    if (type === 'sales' && !cat) return undefined;
    out.push({ type: type as WidgetType, size: size === 'wide' ? 'wide' : 'small', ...(type === 'sales' ? { category: cat } : {}) });
  }
  return out;
}

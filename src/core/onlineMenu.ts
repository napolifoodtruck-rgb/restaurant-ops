/**
 * The online menu: which Square items are sold online, and how. Square stays the source of the
 * items, prices and modifiers; what's published, and how each modifier shows online, is decided
 * here. Nothing is online until a manager turns it on.
 *
 * Each modifier is shown, hidden, or always on. "Always" is for a choice online customers don't
 * get to make: every online pizza is partially cooked, so that option is put on the order for them
 * and its list isn't shown. A modifier Square already hides online starts hidden.
 */

export type ModifierMode = 'shown' | 'hidden' | 'always';
export const MODIFIER_MODES: readonly ModifierMode[] = ['shown', 'hidden', 'always'];

/** Square catalog objects, as much of them as the online menu reads. */
export interface CatalogObject {
  type: string;
  id: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    description?: string;
    description_plaintext?: string;
    is_archived?: boolean;
    category_id?: string;
    categories?: { id: string }[];
    reporting_category?: { id: string };
    image_ids?: string[];
    variations?: { id: string; is_deleted?: boolean; item_variation_data?: { name?: string; ordinal?: number; price_money?: { amount?: number | string } } }[];
    modifier_list_info?: { modifier_list_id: string; enabled?: boolean; hidden_from_customer?: boolean; min_selected_modifiers?: number; max_selected_modifiers?: number; ordinal?: number }[];
  };
  category_data?: { name?: string };
  image_data?: { url?: string };
  modifier_list_data?: {
    name?: string;
    selection_type?: 'SINGLE' | 'MULTIPLE';
    modifiers?: { id: string; is_deleted?: boolean; modifier_data?: { name?: string; price_money?: { amount?: number | string }; hidden_online?: boolean; ordinal?: number } }[];
  };
}

/** What's saved per item. */
export interface OnlineItemSetting {
  itemId: string;
  published: boolean;
  /** Unset: from its category (anything in a category named like "Pizza"). */
  countsAsPizza?: boolean;
  /** Sold out online for this date only. */
  soldOutOn?: string;
}

export interface OnlineModifier { id: string; name: string; price: number; mode: ModifierMode; squareHidesOnline: boolean }
export interface OnlineModifierList { id: string; name: string; single: boolean; min?: number; max?: number; modifiers: OnlineModifier[] }

export interface OnlineMenuItem {
  itemId: string;
  name: string;
  category: string;
  description?: string;
  image?: string;
  variations: { id: string; name: string; price?: number }[];
  published: boolean;
  countsAsPizza: boolean;
  /** Counts as a pizza only because of its category, not because someone said so. */
  pizzaFromCategory: boolean;
  soldOutToday: boolean;
  modifierLists: OnlineModifierList[];
}

const dollars = (amount?: number | string): number | undefined => (amount === undefined ? undefined : Number(amount) / 100);
export const pizzaCategory = (category: string): boolean => /\bpizzas?\b/i.test(category);

/** Every live Square item with its online settings, by category, for the manager's screen. */
export function onlineMenu(objects: readonly CatalogObject[], items: readonly OnlineItemSetting[], modifierModes: Readonly<Record<string, ModifierMode>>, today: string): OnlineMenuItem[] {
  const live = objects.filter((o) => !o.is_deleted);
  const categories = new Map(live.filter((o) => o.type === 'CATEGORY').map((o) => [o.id, o.category_data?.name ?? '']));
  const images = new Map(live.filter((o) => o.type === 'IMAGE').map((o) => [o.id, o.image_data?.url]));
  const lists = new Map(live.filter((o) => o.type === 'MODIFIER_LIST').map((o) => [o.id, o]));
  const settings = new Map(items.map((s) => [s.itemId, s]));

  const out: OnlineMenuItem[] = [];
  for (const o of live) {
    const d = o.item_data;
    if (o.type !== 'ITEM' || !d?.name || d.is_archived) continue;
    const variations = (d.variations ?? []).filter((v) => !v.is_deleted)
      .sort((a, b) => (a.item_variation_data?.ordinal ?? 0) - (b.item_variation_data?.ordinal ?? 0))
      .map((v) => {
        const price = dollars(v.item_variation_data?.price_money?.amount);
        return { id: v.id, name: v.item_variation_data?.name ?? '', ...(price !== undefined ? { price } : {}) };
      });
    if (!variations.length) continue;
    const categoryId = d.reporting_category?.id ?? d.categories?.[0]?.id ?? d.category_id;
    const category = (categoryId && categories.get(categoryId)) || 'Uncategorized';
    const s = settings.get(o.id);
    const modifierLists = [...(d.modifier_list_info ?? [])]
      .filter((info) => info.enabled !== false)
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
      .flatMap((info): OnlineModifierList[] => {
        const list = lists.get(info.modifier_list_id);
        const data = list?.modifier_list_data;
        if (!list || !data) return [];
        const modifiers = (data.modifiers ?? []).filter((m) => !m.is_deleted)
          .sort((a, b) => (a.modifier_data?.ordinal ?? 0) - (b.modifier_data?.ordinal ?? 0))
          .map((m) => {
            const squareHidesOnline = Boolean(m.modifier_data?.hidden_online || info.hidden_from_customer);
            return { id: m.id, name: m.modifier_data?.name ?? '', price: dollars(m.modifier_data?.price_money?.amount) ?? 0, mode: modifierModes[m.id] ?? (squareHidesOnline ? 'hidden' : 'shown'), squareHidesOnline };
          });
        const min = info.min_selected_modifiers !== undefined && info.min_selected_modifiers >= 0 ? info.min_selected_modifiers : undefined;
        const max = info.max_selected_modifiers !== undefined && info.max_selected_modifiers >= 0 ? info.max_selected_modifiers : undefined;
        return [{ id: list.id, name: data.name ?? '', single: data.selection_type === 'SINGLE', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), modifiers }];
      });
    // Square's own image store, not the Square Online site's copies (that site is being replaced).
    const image = (d.image_ids ?? []).map((id) => images.get(id)).find(Boolean);
    const description = d.description_plaintext ?? d.description;
    out.push({
      itemId: o.id,
      name: d.name,
      category,
      ...(description ? { description } : {}),
      ...(image ? { image } : {}),
      variations,
      published: s?.published ?? false,
      countsAsPizza: s?.countsAsPizza ?? pizzaCategory(category),
      pizzaFromCategory: s?.countsAsPizza === undefined && pizzaCategory(category),
      soldOutToday: s?.soldOutOn === today,
      modifierLists,
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/**
 * Problems with a published item's modifiers that would stop customers from ordering it: a list
 * that needs a choice but has nothing left to choose, or more than one "always" in a single-choice list.
 */
export function modifierProblems(item: OnlineMenuItem): string[] {
  const out: string[] = [];
  for (const list of item.modifierLists) {
    const always = list.modifiers.filter((m) => m.mode === 'always');
    const shown = list.modifiers.filter((m) => m.mode === 'shown');
    if (list.single && always.length > 1) out.push(`${list.name}: only one choice can always be on.`);
    else if (!always.length && (list.min ?? 0) > shown.length) out.push(`${list.name}: needs a choice, but every option is hidden online.`);
  }
  return out;
}

/**
 * The email a customer gets once their online order is paid: pickup time, what they ordered,
 * what they paid, and how to finish the partially cooked pizzas at home.
 *
 * The words about partially cooked pizzas match the order page (web/order.js): change both.
 */

export const PARTIAL_TITLE = 'Every online pizza is partially cooked.';
export const PARTIAL_BODY = 'You finish it in your own oven at home, just before eating, so it tastes the way it does here. True Neapolitan pizza is ruined within minutes in a closed box.';
export const FINISH_STEPS = [
  'Preheat your oven to 450°F on convection, or higher.',
  'Once it’s preheated, put the pizza directly on the rack.',
  'Cook 3 to 6 minutes, depending on how crisp you like it.',
  'Add any finishing toppings.',
];

export interface ConfirmationOrder {
  id: string;
  restaurant: string;
  name: string;
  /** "5:00 pm" */
  pickup: string;
  lines: { quantity: number; name: string; total: number; isPizza?: boolean; modifiers: { name: string }[] }[];
  subtotal: number;
  tax: number;
  tip: number;
  /** The order's total with tax, before the tip (as Square has it). */
  total: number;
  receiptUrl?: string | null;
}

export interface Email { subject: string; text: string; html: string }

/** Square names carry kitchen shorthand ("++ Extra Mozzarella", "(ONLY OPTION ONLINE)"): customers see the plain name. */
export function tidy(name: string): string {
  const s = String(name).replace(/\s*\((?:ONLY OPTION ONLINE|NOT AVAILABLE ONLINE)\)/gi, '').replace(/^[\s+*\-–—]+/, '').trim();
  return s === s.toUpperCase() && /[A-Z]/.test(s) ? s.charAt(0) + s.slice(1).toLowerCase() : s;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function confirmationEmail(o: ConfirmationOrder): Email {
  const ref = o.id.slice(0, 8).toUpperCase();
  const pizzas = o.lines.some((l) => l.isPizza ?? true);
  const lines = o.lines.map((l) => ({ what: `${l.quantity} × ${tidy(l.name)}`, mods: l.modifiers.map((m) => tidy(m.name)).filter(Boolean).join(', '), total: money(l.total) }));
  const totals: [string, string][] = [['Subtotal', money(o.subtotal)], ...(o.tax ? [['Tax', money(o.tax)] as [string, string]] : []), ...(o.tip ? [['Tip', money(o.tip)] as [string, string]] : []), ['Total paid', money(o.total + o.tip)]];
  const subject = `Your ${o.restaurant} order: pickup today at ${o.pickup}`;

  const text = [
    `Thank you, ${o.name}! Your order is paid and we’re on it.`,
    '',
    `Pickup today at ${o.pickup}`,
    `Order ${ref}, under the name ${o.name}`,
    '',
    ...lines.flatMap((l) => [`${l.what}  ${l.total}`, ...(l.mods ? [`   ${l.mods}`] : [])]),
    '',
    ...totals.map(([k, v]) => `${k}: ${v}`),
    ...(pizzas ? ['', PARTIAL_TITLE, PARTIAL_BODY, '', 'Finishing at home:', ...FINISH_STEPS.map((s, i) => `${i + 1}. ${s}`)] : []),
    ...(o.receiptUrl ? ['', `Your receipt: ${o.receiptUrl}`] : []),
    '',
    `See you soon,`,
    o.restaurant,
  ].join('\n');

  const cell = 'padding:6px 0;vertical-align:top';
  const html = `<!doctype html><html><body style="margin:0;background:#F6F4EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1b19">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border-radius:16px;padding:24px">
<p style="margin:0 0 4px;font-size:14px;color:#6b665e">${escape(o.restaurant)}</p>
<h1 style="margin:0 0 16px;font-size:22px">Thank you, ${escape(o.name)}!</h1>
<p style="margin:0 0 4px;font-size:18px"><b>Pickup today at ${escape(o.pickup)}</b></p>
<p style="margin:0 0 20px;color:#6b665e">Order ${escape(ref)}, under the name ${escape(o.name)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px">
${lines.map((l) => `<tr><td style="${cell}">${escape(l.what)}${l.mods ? `<br><span style="color:#6b665e;font-size:13px">${escape(l.mods)}</span>` : ''}</td><td style="${cell};text-align:right;white-space:nowrap">${escape(l.total)}</td></tr>`).join('\n')}
${totals.map(([k, v], i) => `<tr><td style="${cell}${i === 0 ? ';border-top:1px solid #e6e2da' : ''}${i === totals.length - 1 ? ';font-weight:bold' : ';color:#6b665e'}">${escape(k)}</td><td style="${cell};text-align:right${i === 0 ? ';border-top:1px solid #e6e2da' : ''}${i === totals.length - 1 ? ';font-weight:bold' : ''}">${escape(v)}</td></tr>`).join('\n')}
</table>
${pizzas ? `<div style="margin-top:20px;padding:16px;background:#FBF3E4;border-radius:12px">
<p style="margin:0 0 6px"><b>${escape(PARTIAL_TITLE)}</b></p>
<p style="margin:0 0 12px">${escape(PARTIAL_BODY)}</p>
<p style="margin:0 0 6px"><b>Finishing at home</b></p>
<ol style="margin:0;padding-left:20px">${FINISH_STEPS.map((s) => `<li style="margin:2px 0">${escape(s)}</li>`).join('')}</ol>
</div>` : ''}
${o.receiptUrl ? `<p style="margin:20px 0 0"><a href="${escape(o.receiptUrl)}" style="color:#1c1b19">View your receipt</a></p>` : ''}
</div>
<p style="text-align:center;color:#6b665e;font-size:13px;margin:16px 0 0">See you soon, ${escape(o.restaurant)}</p>
</div></body></html>`;

  return { subject, text, html };
}

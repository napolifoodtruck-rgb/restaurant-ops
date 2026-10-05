// The web app. Plain modules, no build step. Every screen is built with h() from data the
// API returns, never from HTML strings, so names and messages can't inject markup.

const app = document.getElementById('app');

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const ICONS = {
  today: 'M4 4h16v16H4z M8.5 12.5l2.5 2.5 4.5-5',
  prep: 'M5 4h14v17H5z M9 4h6v3H9z M9 12h6 M9 16h4',
  menu: 'M4 5.5C6.5 4.5 9.5 4.5 12 6c2.5-1.5 5.5-1.5 8-.5V19c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5z M12 6v13.5',
  margins: 'M4 20V4 M4 20h16 M8 16v-4 M12 16V8 M16 16v-6',
  orders: 'M3 7h11v9H3z M14 10h4l3 3v3h-7',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12h2 M3 12h2 M12 3v2 M12 19v2 M17 7l1.5-1.5 M5.5 18.5L7 17 M17 17l1.5 1.5 M5.5 5.5L7 7',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '22'); svg.setAttribute('height', '22'); svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

function show(...nodes) { app.replaceChildren(...nodes); }

const LEVEL_NAMES = { line: 'Line', lead: 'Lead', sous: 'Sous chef', chef: 'Chef', manager: 'Manager', owner: 'Owner' };
const LEVELS = ['line', 'lead', 'sous', 'chef', 'manager', 'owner'];
const atLeast = (level, needed) => LEVELS.indexOf(level) >= LEVELS.indexOf(needed);

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ------------------------------------------------------------------ start

async function start() {
  const me = await api('GET', '/api/me');
  if (me.ok) return home(me.data.me);
  const device = await api('GET', '/api/devices/staff');
  if (device.ok) return pinNames(device.data);
  const setup = await api('GET', '/api/setup');
  if (setup.ok && setup.data.open) return setupScreen();
  return emailSignIn();
}

// ------------------------------------------------------------------ first-time setup

function setupScreen() {
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      const r = await api('POST', '/api/setup', Object.fromEntries(f));
      button.disabled = false;
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      home(r.data.me);
    } },
    h('div', {}, h('div', { class: 'kicker', text: 'First-time setup' }), h('h1', { text: 'Set up your restaurant' }),
      h('div', { class: 'sub', text: 'You’ll be the owner. Your team comes in from Square once it’s connected.' })),
    h('label', {}, 'Restaurant name', h('input', { type: 'text', name: 'restaurantName', required: true, autocomplete: 'organization' })),
    h('label', {}, 'Your name', h('input', { type: 'text', name: 'name', required: true, autocomplete: 'name' })),
    h('label', {}, 'Your email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })),
    h('label', {}, 'Password (10 characters or more)', h('input', { type: 'password', name: 'password', required: true, minlength: '10', autocomplete: 'new-password' })),
    h('label', {}, 'Setup code', h('input', { type: 'password', name: 'token', required: true, autocomplete: 'off' }),
      h('span', { class: 'small muted', text: 'In Render: your web service → Environment → SETUP_TOKEN.' })),
    err,
    h('button', { class: 'btn dark', type: 'submit', text: 'Create and sign in' }),
  );
  show(h('div', { class: 'center' }, form));
}

// ------------------------------------------------------------------ manager sign-in

function emailSignIn(backToPins) {
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const r = await api('POST', '/api/login/password', f);
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      home(r.data.me);
    } },
    h('div', {}, h('h1', { text: 'Sign in' }), h('div', { class: 'sub', text: 'Managers and owners. Kitchen iPads use names and PINs once a manager sets them up.' })),
    h('label', {}, 'Email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' })),
    h('label', {}, 'Password', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
    err,
    h('button', { class: 'btn dark', type: 'submit', text: 'Sign in' }),
    backToPins ? h('button', { class: 'link', type: 'button', onclick: start, text: '← Back to names' }) : null,
  );
  show(h('div', { class: 'center' }, form));
}

// ------------------------------------------------------------------ kitchen iPad: name, then PIN

function pinNames({ device, staff }) {
  const withPin = staff.filter((s) => s.hasPin);
  show(h('div', { class: 'center' }, h('div', { class: 'names-wrap' },
    h('div', { class: 'kicker', text: device }),
    h('h1', { text: 'Who’s working?' }),
    h('div', { class: 'sub', text: withPin.length ? 'Tap your name.' : 'No one has a PIN yet. A manager can set PINs under Settings.' }),
    h('div', { class: 'names', style: undefined }, withPin.map((s) => h('button', { onclick: () => pinPad(s, device) }, s.name))),
    h('button', { class: 'link', onclick: () => emailSignIn(true), text: 'Manager sign in with email' }),
  )));
}

function pinPad(person, device) {
  let pin = '';
  const dots = h('div', { class: 'dots', 'aria-label': 'PIN entered' });
  const err = h('div', { class: 'error', role: 'alert' });
  const draw = () => dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
  const press = (d) => { if (pin.length < 6) { pin += d; err.textContent = ''; draw(); } };
  const go = async () => {
    if (pin.length < 4) return (err.textContent = 'At least 4 digits.');
    const r = await api('POST', '/api/login/pin', { staffId: person.id, pin });
    pin = ''; draw();
    if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
    home(r.data.me);
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => h('button', { onclick: () => press(d), text: d }));
  draw();
  show(h('div', { class: 'center' }, h('div', { class: 'panel' },
    h('div', {}, h('div', { class: 'kicker', text: device }), h('h1', { text: person.name }), h('div', { class: 'sub', text: 'Enter your PIN.' })),
    dots, err,
    h('div', { class: 'pinpad' }, keys,
      h('button', { onclick: () => { pin = pin.slice(0, -1); draw(); }, 'aria-label': 'Delete', text: '⌫' }),
      h('button', { onclick: () => press('0'), text: '0' }),
      h('button', { class: 'go', onclick: go, text: 'Go' })),
    h('button', { class: 'link', onclick: start, text: '← Not you?' }),
  )));
}

// ------------------------------------------------------------------ signed in

function shell(me, active, content) {
  const nav = [
    ['today', 'Today'], ['prep', 'Prep'], ['menu', 'Menu'], ['margins', 'Margins'], ['orders', 'Orders'],
  ];
  return h('div', { class: 'shell' },
    h('nav', { class: 'rail', 'aria-label': 'Main' },
      h('div', { class: 'logo', text: (me.restaurantName ?? 'N')[0] }),
      nav.map(([key, label]) => h('button', { class: active === key ? 'on' : '', disabled: true, title: 'Coming next' }, icon(key), label)),
      h('div', { class: 'spacer' }),
      h('button', { class: active === 'settings' ? 'on' : '', onclick: () => home(me) }, icon('settings'), 'Settings'),
    ),
    h('main', {}, content),
  );
}

async function home(me) {
  const manager = atLeast(me.roleLevel, 'manager');
  const signOut = h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/logout'); start(); }, text: 'Sign out' });
  const header = h('header', { class: 'row' },
    h('div', { class: 'grow' }, h('div', { class: 'kicker', text: `${me.name} · ${LEVEL_NAMES[me.roleLevel] ?? me.roleLevel}` }), h('h1', { text: 'Settings' }),
      h('div', { class: 'sub', text: manager ? 'Today, Prep, Menu, Margins and Orders come next. This is where the app gets connected.' : 'Your prep list will show up here once your station is set up.' })),
    signOut);
  const cards = [ownPinCard(me)];
  if (manager) cards.unshift(await squareCard(), await teamCard(me), deviceCard());
  show(shell(me, 'settings', [header, h('div', { class: 'grid' }, cards)]));
}

// Square connection and syncs.
async function squareCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Square' });
  const draw = async () => {
    const r = await api('GET', '/api/sync');
    const runs = (r.data.runs ?? []).filter((x) => x.source === 'square');
    const last = runs[0];
    const status = !r.data.squareConnected ? h('span', { class: 'tag warn', text: 'Not connected' })
      : !last ? h('span', { class: 'tag', text: 'Not synced yet' })
      : last.status === 'ok' ? h('span', { class: 'tag ok', text: 'Synced' })
      : last.status === 'running' ? h('span', { class: 'tag warn', text: 'Syncing…' })
      : h('span', { class: 'tag bad', text: 'Last sync failed' });
    const detail = last?.detail ?? {};
    const lines = [];
    if (!r.data.squareConnected) lines.push(h('div', { class: 'small muted', text: 'Add SQUARE_ACCESS_TOKEN in Render (web service → Environment), then redeploy. The app only reads from Square.' }));
    if (last?.status === 'ok') {
      lines.push(h('div', { class: 'small', text: `${when(last.finished_at)}: sales ${detail.from} to ${detail.to}, ${detail.itemRows} item rows, ${detail.modifierRows} modifier rows, ${detail.catalogObjects} catalog entries.` }));
      const t = detail.team ?? {};
      lines.push(h('div', { class: 'small muted', text: `Team: ${t.added ?? 0} added, ${t.updated ?? 0} updated, ${t.deactivated ?? 0} no longer active.` }));
    }
    if (last?.status === 'failed') lines.push(h('div', { class: 'error', text: detail.error ?? 'Unknown error' }));
    if (last?.status === 'running') setTimeout(draw, 5000);
    const button = h('button', { class: 'btn dark', disabled: !r.data.squareConnected || last?.status === 'running', text: 'Sync now', onclick: async () => {
        button.disabled = true;
        const s = await api('POST', '/api/sync/square');
        if (!s.ok) lines.push(h('div', { class: 'error', text: s.data.error }));
        setTimeout(draw, 1500);
      } });
    box.replaceChildren(
      h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Square' }), status),
      ...lines,
      h('div', { class: 'small muted', text: 'Syncs by itself every night after 4 am.' }),
      h('div', {}, button),
    );
  };
  await draw();
  return box;
}

// The team, from Square, with PINs.
async function teamCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Team' });
  const r = await api('GET', '/api/staff');
  const people = r.data.staff ?? [];
  const list = h('div', { class: 'list' }, people.map((p) => personRow(p, me)));
  box.replaceChildren(
    h('div', { class: 'row' }, h('h2', { class: 'grow', text: 'Team' }), h('span', { class: 'small muted', text: `${people.length} active` })),
    h('div', { class: 'small muted', text: 'Names and job titles come from Square. Each cook needs a PIN to sign in on a kitchen iPad.' }),
    list,
  );
  return box;
}

function personRow(p, me) {
  const row = h('div');
  const draw = () => row.replaceChildren(
    h('div', { class: 'grow' }, h('div', { text: p.name }), h('div', { class: 'small muted', text: [p.jobTitle, LEVEL_NAMES[p.roleLevel]].filter(Boolean).join(' · ') })),
    p.hasPin ? h('span', { class: 'tag ok', text: 'PIN set' }) : h('span', { class: 'tag', text: 'No PIN' }),
    h('button', { class: 'btn', onclick: () => pinForm(row, p, () => { p.hasPin = true; draw(); }, draw), text: p.hasPin ? 'Change' : 'Set PIN' }),
  );
  draw();
  return row;
}

function pinForm(container, person, onDone, onCancel) {
  const err = h('span', { class: 'error' });
  const input = h('input', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off', 'aria-label': `New PIN for ${person.name}`, placeholder: '4–6 digits' });
  const form = h('form', { class: 'row grow', onsubmit: async (e) => {
      e.preventDefault();
      const r = await api('POST', `/api/staff/${person.id}/pin`, { pin: input.value });
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      onDone();
    } },
    h('div', { class: 'grow' }, h('div', { text: person.name }), err),
    input, h('button', { class: 'btn dark', type: 'submit', text: 'Save' }), h('button', { class: 'btn', type: 'button', onclick: onCancel, text: 'Cancel' }));
  container.replaceChildren(form);
  input.focus();
}

function ownPinCard(me) {
  const box = h('section', { class: 'card', 'aria-label': 'Your PIN' });
  const draw = () => box.replaceChildren(
    h('h2', { text: 'Your PIN' }),
    h('div', { class: 'small muted', text: 'For signing in on a kitchen iPad. 4 to 6 digits, not a run like 1234.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Set my PIN', onclick: () => {
      const slot = h('div', { class: 'row' });
      box.replaceChildren(h('h2', { text: 'Your PIN' }), slot);
      pinForm(slot, { id: me.staffId, name: me.name }, () => { draw(); box.append(h('div', { class: 'tag ok', text: 'Saved' })); }, draw);
    } })),
  );
  draw();
  return box;
}

// Turn this browser into a kitchen iPad.
function deviceCard() {
  const box = h('section', { class: 'card', 'aria-label': 'Kitchen iPad' });
  const err = h('div', { class: 'error' });
  const input = h('input', { type: 'text', placeholder: 'e.g. Pizza station iPad', 'aria-label': 'Name for this iPad', required: true });
  const form = h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      const r = await api('POST', '/api/devices', { name: input.value });
      if (!r.ok) return (err.textContent = r.data.error ?? 'That didn’t work.');
      box.replaceChildren(h('h2', { text: 'Kitchen iPad' }), h('div', { class: 'note', text: `This iPad is set up as “${input.value}”. Sign out, and cooks will see their names here.` }));
    } }, h('div', { class: 'grow' }, input), h('button', { class: 'btn dark', type: 'submit', text: 'Set up' }));
  box.replaceChildren(
    h('h2', { text: 'Kitchen iPad' }),
    h('div', { class: 'small muted', text: 'Do this once on each kitchen iPad, signed in as a manager. Afterwards cooks sign in on it with their name and PIN.' }),
    form, err,
  );
  return box;
}

start();

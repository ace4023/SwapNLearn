// Color themes: the choice is remembered in this browser
const THEMES = [
  ['lavender', 'Lavender'], ['peach', 'Peach'], ['peach-rose', 'Peach Rose'], ['peach-sage', 'Peach Sage'],
  ['peach-lavender', 'Peach Lavender'], ['peach-teal', 'Peach Teal'], ['peach-honey', 'Peach Honey'],
  ['sage', 'Sage'], ['sky', 'Sky']
];
try {
  const saved = localStorage.getItem('theme');
  if (THEMES.some(t => t[0] === saved)) document.documentElement.dataset.theme = saved;
} catch {}

// Shared helpers used by every page
async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// Tiny DOM builder. Text is always added as text (never HTML), so user content can't inject markup.
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  kids.flat().filter(c => c != null && c !== false).forEach(c => e.append(c));
  return e;
}

function chips(list, kind = '') {
  return h('div', { class: 'chips' }, list.map(s => h('span', { class: 'chip ' + kind }, typeof s === 'string' ? s : s.name + ' · ' + s.level)));
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.style.display = 'none'), 3000);
}

// Redirects to the login page if nobody is signed in; otherwise draws the top bar.
async function requireUser(active) {
  let user;
  try { ({ user } = await api('/api/me')); } catch { location.href = '/'; return null; }
  const nav = document.getElementById('nav');
  nav.append(
    h('a', { class: 'brand', href: 'chat.html' }, 'SwapNLearn'),
    h('a', { href: 'chat.html', class: active === 'chat' ? 'on' : '' }, 'Chat'),
    h('a', { href: 'scroll.html', class: active === 'scroll' ? 'on' : '' }, 'Scroll'),
    h('a', { href: 'messages.html', class: active === 'messages' ? 'on' : '' }, 'Messages', h('span', { class: 'badge', id: 'badge', hidden: '' })),
    h('a', { href: 'profile.html', class: active === 'profile' ? 'on' : '' }, 'Profile'),
    h('span', { class: 'grow' }),
    h('select', {
      id: 'themePick', 'aria-label': 'Color theme',
      onchange: e => { document.documentElement.dataset.theme = e.target.value; try { localStorage.setItem('theme', e.target.value); } catch {} }
    }, THEMES.map(([v, n]) => h('option', { value: v }, n))),
    h('span', { class: 'me' }, '@' + user.username),
    h('button', { class: 'ghost', onclick: async () => { await api('/api/logout', 'POST'); location.href = '/'; } }, 'Log out')
  );
  document.getElementById('themePick').value = document.documentElement.dataset.theme || 'lavender';
  refreshBadge();
  return user;
}

async function refreshBadge() {
  try {
    const { count } = await api('/api/unread');
    const b = document.getElementById('badge');
    if (b) { b.textContent = count; b.hidden = !count; }
  } catch {}
}

// Pages that have a socket call this for live alerts. onMessage may return true to say "handled".
function watchMessages(socket, onMessage) {
  socket.on('dm:new', m => {
    if (onMessage && onMessage(m) === true) return;
    toast(m.kind === 'interest' ? m.fromName + ' is interested in your ' + m.language + ' course' : 'New message from ' + m.fromName);
    refreshBadge();
  });
}

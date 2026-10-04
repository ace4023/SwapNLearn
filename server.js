// SwapNLearn prototype server: auth + profiles + chat rooms (Express + Socket.IO)
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { LANGUAGES, LEVELS } = require('./public/languages.js');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');

// ---------- tiny JSON "database" (swap for SQLite/Postgres later) ----------
let db = { users: [], messages: [], dms: [] };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
let timer;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)), 100);
}
const newId = () => crypto.randomBytes(6).toString('hex');
const GENERAL = 'general'; // the public lobby
if (db.rooms) { // older data files stored rooms; keep only the old General history
  const old = db.rooms.find(r => r.name === 'General');
  db.messages = (db.messages || []).filter(m => old && m.roomId === old.id).map(m => ({ ...m, roomId: GENERAL }));
  delete db.rooms;
  save();
}

// ---------- app + session ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const sessionMw = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(express.json({ limit: '20kb' }));
app.use(sessionMw);
io.engine.use(sessionMw); // sockets reuse the same login session

// ---------- helpers ----------
const publicUser = u => ({
  username: u.username, displayName: u.displayName, bio: u.bio,
  skillsTeach: u.skillsTeach, skillsLearn: u.skillsLearn
});
// Skills are limited to the known programming languages; "have" and "teach" also carry a level.
function cleanSkills(list, withLevel) {
  const out = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    const raw = typeof s === 'string' ? s : s && s.name;
    const name = LANGUAGES.find(l => l.toLowerCase() === String(raw || '').trim().toLowerCase());
    if (!name || out.has(name)) continue;
    const level = LEVELS.includes(s && s.level) ? s.level : LEVELS[0];
    out.set(name, withLevel ? { name, level } : name);
  }
  return [...out.values()].slice(0, 20);
}
// Convert profiles saved by earlier versions (free-text skills) to the new format
db.dms = db.dms || [];
db.users.forEach(u => {
  delete u.skillsHave; // "skills I have" was removed from profiles
  u.reads = u.reads || {};
  u.skillsTeach = cleanSkills(u.skillsTeach, true);
  u.skillsLearn = cleanSkills(u.skillsLearn, false);
});
const findUser = name => db.users.find(u => u.username === String(name || '').toLowerCase());
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const NAME_RE = /^\p{L}+(?: \p{L}+)*$/u; // letters only (single spaces between words)
function passwordProblem(pw) {
  if (pw.length < 8 || pw.length > 72) return 'Password must be 8–72 characters';
  if (!/[A-Z]/.test(pw)) return 'Password needs at least one capital letter';
  if (!/[a-z]/.test(pw)) return 'Password needs at least one small letter';
  if (!/[^A-Za-z0-9\s]/.test(pw)) return 'Password needs at least one special character (e.g. @ # ! $)';
  return null;
}
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function requireAuth(req, res, next) {
  const u = db.users.find(x => x.id === req.session.userId);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u;
  next();
}
function startSession(req, res, user) {
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
}

// ---------- auth ----------
app.post('/api/signup', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.displayName || '').trim().replace(/\s+/g, ' ');
  if (!USERNAME_RE.test(username))
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers and _ only' });
  if (displayName.length < 2 || displayName.length > 40 || !NAME_RE.test(displayName))
    return res.status(400).json({ error: 'Name must contain letters only (2–40 characters)' });
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (findUser(username)) return res.status(409).json({ error: 'That username is taken' });
  const passwordHash = await bcrypt.hash(password, 10);
  if (findUser(username)) return res.status(409).json({ error: 'That username is taken' });
  const user = {
    id: newId(), username, displayName, passwordHash, bio: '',
    skillsTeach: [], skillsLearn: [], reads: {}, createdAt: Date.now()
  };
  db.users.push(user);
  save();
  startSession(req, res, user);
});

app.post('/api/login', async (req, res) => {
  const user = findUser(req.body.username);
  const ok = await bcrypt.compare(String(req.body.password || ''), user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid username or password' });
  startSession(req, res, user);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- profiles ----------
app.put('/api/profile', requireAuth, (req, res) => {
  const u = req.user;
  const displayName = String(req.body.displayName || '').trim().replace(/\s+/g, ' ');
  if (displayName.length < 2 || displayName.length > 40 || !NAME_RE.test(displayName))
    return res.status(400).json({ error: 'Name must contain letters only (2–40 characters)' });
  u.displayName = displayName;
  u.bio = String(req.body.bio || '').trim().slice(0, 300);
  u.skillsTeach = cleanSkills(req.body.skillsTeach, true);
  u.skillsLearn = cleanSkills(req.body.skillsLearn, false);
  save();
  res.json({ user: publicUser(u) });
});

app.get('/api/users', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const hit = u => !q || [u.username, u.displayName, ...u.skillsTeach.map(x => x.name), ...u.skillsLearn]
    .some(s => s.toLowerCase().includes(q));
  res.json({ users: db.users.filter(hit).map(publicUser) });
});

app.get('/api/users/:username', requireAuth, (req, res) => {
  const u = findUser(req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(u) });
});

// ---------- rooms ----------
// General is a public lobby that is always open. Every other room is private and timed:
// it needs the host's code to enter, lives in memory only, and disappears when its timer ends.
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join(''); }
  while ([...rooms.values()].some(r => r.code === c));
  return c;
}
function makeMsg(roomId, who, text, invite) {
  const m = { id: newId(), roomId, text, ts: Date.now(), username: who.username, displayName: who.displayName };
  if (invite) m.invite = invite;
  return m;
}
function present(roomId) { // usernames currently inside a room
  const names = new Set();
  for (const sid of io.sockets.adapter.rooms.get(roomId) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) names.add(s.data.username);
  }
  return names;
}
// A room is listed only while it is running AND someone is inside. Codes are never listed.
function liveList() {
  return [...rooms.values()].filter(r => present(r.id).size > 0).map(r => ({
    id: r.id, name: r.name, hostName: r.hostName, endsAt: r.endsAt, count: present(r.id).size
  }));
}
const pushLive = () => io.emit('rooms:live', { now: Date.now(), rooms: liveList() });

function endRoom(id) {
  const r = rooms.get(id);
  if (!r) return;
  clearTimeout(r.timer);
  rooms.delete(id);
  io.to(id).emit('room:ended', { roomId: id, name: r.name });
  io.in(id).socketsLeave(id);
  pushLive();
}
function hostedRoom(req, res) {
  const r = rooms.get(req.params.id);
  if (!r || r.host !== req.user.username) { res.status(403).json({ error: 'Only the host of a running room can do that' }); return null; }
  return r;
}

app.get('/api/rooms', requireAuth, (req, res) => res.json({ now: Date.now(), rooms: liveList() }));

app.post('/api/rooms', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const minutes = Math.round(Number(req.body.minutes));
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Room name must be 2–40 characters' });
  if (!(minutes >= 5 && minutes <= 120)) return res.status(400).json({ error: 'Choose a duration of 5–120 minutes' });
  const room = {
    id: newId(), name, code: newCode(), host: req.user.username, hostName: req.user.displayName,
    endsAt: Date.now() + minutes * 60000, members: new Set([req.user.username]), messages: []
  };
  room.timer = setTimeout(() => endRoom(room.id), minutes * 60000);
  rooms.set(room.id, room);
  res.json({ room: { id: room.id, name: room.name } });
});

app.post('/api/rooms/join', requireAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const r = [...rooms.values()].find(x => x.code === code);
  if (!r) return res.status(404).json({ error: 'That code is not valid, or the room has ended' });
  r.members.add(req.user.username);
  res.json({ room: { id: r.id, name: r.name } });
});

app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  if (req.params.id === GENERAL)
    return res.json({ messages: db.messages.filter(m => m.roomId === GENERAL).slice(-100) });
  const r = rooms.get(req.params.id);
  if (!r || !r.members.has(req.user.username)) return res.status(403).json({ error: 'Enter the room code first' });
  res.json({ messages: r.messages.slice(-100) });
});

// Host posts the join code into the public General chat
app.post('/api/rooms/:id/share', requireAuth, (req, res) => {
  const r = hostedRoom(req, res);
  if (!r) return;
  const msg = makeMsg(GENERAL, req.user, `I started “${r.name}”. Paste this code to join.`,
    { code: r.code, name: r.name, endsAt: r.endsAt });
  db.messages.push(msg);
  save();
  io.to(GENERAL).emit('message:new', msg);
  res.json({ ok: true });
});

app.post('/api/rooms/:id/end', requireAuth, (req, res) => {
  const r = hostedRoom(req, res);
  if (!r) return;
  endRoom(r.id);
  res.json({ ok: true });
});

// ---------- realtime chat ----------
io.use((socket, next) => {
  const uid = socket.request.session && socket.request.session.userId;
  const u = db.users.find(x => x.id === uid);
  if (!u) return next(new Error('unauthorized'));
  socket.data.username = u.username;
  socket.data.displayName = u.displayName;
  next();
});

async function broadcastMembers(roomId) {
  const sockets = await io.in(roomId).fetchSockets();
  const seen = new Map();
  sockets.forEach(s => seen.set(s.data.username, s.data.displayName));
  const members = [...seen].map(([username, displayName]) => ({ username, displayName }));
  io.to(roomId).emit('room:members', { roomId, members });
  pushLive();
}

io.on('connection', socket => {
  socket.on('room:join', async (roomId, ack) => {
    const r = rooms.get(roomId);
    if (roomId !== GENERAL) {
      if (!r) return ack && ack({ error: 'That room has ended or does not exist' });
      if (!r.members.has(socket.data.username)) return ack && ack({ needCode: true, name: r.name });
    }
    for (const x of socket.rooms) {
      if (x !== socket.id && x !== roomId) { socket.leave(x); broadcastMembers(x); }
    }
    await socket.join(roomId);
    await broadcastMembers(roomId);
    ack && ack({
      ok: true, now: Date.now(), endsAt: r ? r.endsAt : null,
      code: r && r.host === socket.data.username ? r.code : null
    });
  });

  socket.on('message:send', (payload, ack) => {
    const roomId = payload && payload.roomId;
    const text = String((payload && payload.text) || '').trim().slice(0, 1000);
    const r = rooms.get(roomId);
    if (!text || !socket.rooms.has(roomId) || (roomId !== GENERAL && !r))
      return ack && ack({ error: 'Join the room first' });
    const msg = makeMsg(roomId, socket.data, text);
    if (r) r.messages.push(msg);
    else { db.messages.push(msg); save(); }
    io.to(roomId).emit('message:new', msg);
    ack && ack({ ok: true });
  });

  socket.on('disconnecting', () => {
    for (const x of socket.rooms) if (x !== socket.id) setTimeout(() => broadcastMembers(x), 50);
  });
});

// ---------- scroll (what people teach) + direct messages ----------
const convKey = (a, b) => [a, b].sort().join('|');
const nameOf = un => (findUser(un) || {}).displayName || un;
function notifyUser(username, event, payload) {
  for (const s of io.sockets.sockets.values()) if (s.data.username === username) s.emit(event, payload);
}
const threadWith = (a, b) => db.dms.filter(m => m.key === convKey(a, b));
function unreadFrom(user, other) {
  const seenAt = user.reads[other] || 0;
  return threadWith(user.username, other).filter(m => m.to === user.username && m.ts > seenAt).length;
}
function sendDm(from, to, fields) {
  const m = { id: newId(), key: convKey(from, to), from, to, ts: Date.now(), ...fields };
  db.dms.push(m);
  save();
  notifyUser(to, 'dm:new', { ...m, fromName: nameOf(from) });
  return m;
}

// Scroll: every language someone teaches, shown with their username
app.get('/api/feed', requireAuth, (req, res) => {
  const lang = String(req.query.lang || '');
  const q = String(req.query.q || '').trim().toLowerCase();
  const sent = new Set(db.dms.filter(m => m.kind === 'interest' && m.from === req.user.username).map(m => m.to + '|' + m.language));
  const posts = [];
  for (const u of [...db.users].reverse()) {
    if (q && !u.username.includes(q) && !u.displayName.toLowerCase().includes(q)) continue;
    for (const s of u.skillsTeach) {
      if (lang && s.name !== lang) continue;
      posts.push({
        username: u.username, displayName: u.displayName, bio: u.bio, language: s.name, level: s.level,
        learn: u.skillsLearn, mine: u.username === req.user.username, sent: sent.has(u.username + '|' + s.name)
      });
    }
  }
  res.json({ posts });
});

// "I'm interested": notifies the teacher and opens a conversation between the two
app.post('/api/interest', requireAuth, (req, res) => {
  const to = findUser(req.body.to);
  const skill = to && to.skillsTeach.find(s => s.name === req.body.language);
  if (!skill) return res.status(404).json({ error: 'That course is no longer offered' });
  if (to.id === req.user.id) return res.status(400).json({ error: 'That is your own course' });
  if (db.dms.some(m => m.kind === 'interest' && m.from === req.user.username && m.to === to.username && m.language === skill.name))
    return res.status(409).json({ error: `You already told ${to.displayName} you are interested in ${skill.name}` });
  sendDm(req.user.username, to.username, {
    kind: 'interest', language: skill.name, level: skill.level, text: String(req.body.note || '').trim().slice(0, 300)
  });
  res.json({ ok: true });
});

app.get('/api/messages', requireAuth, (req, res) => {
  const me = req.user.username;
  const last = new Map();
  for (const m of db.dms) if (m.from === me || m.to === me) last.set(m.from === me ? m.to : m.from, m);
  const conversations = [...last]
    .map(([un, m]) => ({ username: un, displayName: nameOf(un), last: m, unread: unreadFrom(req.user, un) }))
    .sort((a, b) => b.last.ts - a.last.ts);
  res.json({ conversations });
});

app.get('/api/messages/:username', requireAuth, (req, res) => {
  const other = findUser(req.params.username);
  const messages = other ? threadWith(req.user.username, other.username) : [];
  if (!messages.length) return res.status(404).json({ error: 'No conversation with that person yet' });
  req.user.reads[other.username] = Date.now();
  save();
  res.json({ user: publicUser(other), messages: messages.slice(-200) });
});

app.post('/api/messages/:username', requireAuth, (req, res) => {
  const other = findUser(req.params.username);
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!other || !threadWith(req.user.username, other.username).length)
    return res.status(403).json({ error: 'Start from Scroll by telling them you are interested' });
  if (!text) return res.status(400).json({ error: 'Write a message first' });
  res.json({ message: sendDm(req.user.username, other.username, { kind: 'text', text }) });
});

app.get('/api/unread', requireAuth, (req, res) => {
  const others = new Set(db.dms.filter(m => m.to === req.user.username).map(m => m.from));
  let count = 0;
  others.forEach(o => (count += unreadFrom(req.user, o)));
  res.json({ count });
});

// ---------- static pages ----------
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  const indexFile = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(indexFile)) {
    console.log('\n!! Cannot find ' + indexFile);
    console.log('!! Create a folder named "public" next to server.js and put index.html, chat.html,');
    console.log('!! profile.html, common.js and style.css inside it, then restart.\n');
  }
  console.log(`\nSwapNLearn running:\n  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal) console.log(`  Same Wi-Fi:     http://${i.address}:${PORT}`);
  console.log('');
});

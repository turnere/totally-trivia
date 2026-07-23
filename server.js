// Totally Trivia — standup trivia server.
// Zero dependencies: node:http + node:sqlite + Server-Sent Events.
// Run: node server.js   (PORT and TRIVIA_PASSWORD env vars optional)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3311);
const PASSWORD = process.env.TRIVIA_PASSWORD || 'chickadee';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'trivia.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS spectator_tokens (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  host_id INTEGER NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'active',      -- active | archived
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  date TEXT NOT NULL,                         -- YYYY-MM-DD (server local)
  status TEXT NOT NULL DEFAULT 'open',        -- open | closed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  session_id INTEGER REFERENCES sessions(id), -- null while draft
  text TEXT NOT NULL,
  answer TEXT NOT NULL,                       -- canonical written answer
  choices TEXT NOT NULL,                      -- JSON array
  correct_index INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'draft',        -- draft|guessing|reveal|choosing|results|closed
  asked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS legacy_points (
  id INTEGER PRIMARY KEY,
  round_id INTEGER REFERENCES rounds(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  date TEXT NOT NULL,
  points INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS answers (
  question_id INTEGER NOT NULL REFERENCES questions(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  guess TEXT,
  guess_correct INTEGER NOT NULL DEFAULT 0,
  choice_index INTEGER,
  points INTEGER NOT NULL DEFAULT 0,
  is_makeup INTEGER NOT NULL DEFAULT 0,
  forfeited INTEGER NOT NULL DEFAULT 0,
  finalized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (question_id, player_id)
);
`);

// Migrations for columns added after first release (no-ops once applied).
for (const stmt of [
  'ALTER TABLE players ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE questions ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE questions ADD COLUMN historical INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE questions ADD COLUMN scheduled_for TEXT',
]) {
  try { db.exec(stmt); } catch { /* column already exists */ }
}

// Bird avatar species — the players.emoji column stores one of these slugs (or '' for initials).
const BIRD_AVATARS = new Set([
  'cardinal', 'bluejay', 'owl', 'penguin', 'flamingo', 'mallard',
  'chickadee', 'goldfinch', 'toucan', 'puffin', 'hummingbird', 'crow',
  'falcon', 'eagle', 'loon',
]);

// ---------- helpers ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/^(a|an|the)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Auto-judge a written guess against the canonical answer and the correct choice.
// The host can always override — this just picks a sensible default.
function autoJudge(guess, question) {
  const g = normalize(guess);
  if (!g) return 0;
  const targets = [question.answer, JSON.parse(question.choices)[question.correct_index]];
  for (const t of targets) {
    const n = normalize(t);
    if (!n) continue;
    if (g === n) return 1;
    const tolerance = n.length >= 8 ? 2 : n.length >= 5 ? 1 : 0;
    if (tolerance && levenshtein(g, n) <= tolerance) return 1;
  }
  return 0;
}

function computePoints(row, question) {
  if (row.forfeited) return 0;
  if (row.choice_index === null || row.choice_index === undefined) return 0;
  if (row.choice_index !== question.correct_index) return 0;
  return row.guess_correct ? 2 : 1;
}

const q = {
  playerByToken: db.prepare('SELECT p.* FROM tokens t JOIN players p ON p.id = t.player_id WHERE t.token = ? AND p.deleted = 0'),
  allPlayers: db.prepare('SELECT id, name, emoji FROM players WHERE deleted = 0 ORDER BY name'),
  deletedPlayers: db.prepare('SELECT id, name FROM players WHERE deleted = 1 ORDER BY name'),
  // Any number of rounds can be active at once (concurrent hosts, e.g. two topics same day).
  activeRounds: db.prepare(`SELECT r.*, p.name AS host_name, p.emoji AS host_emoji
                           FROM rounds r JOIN players p ON p.id = r.host_id
                           WHERE r.status = 'active' ORDER BY r.id`),
  openSession: db.prepare(`SELECT * FROM sessions WHERE round_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`),
  currentQuestion: db.prepare(`SELECT * FROM questions WHERE session_id = ? AND deleted = 0 AND phase IN ('guessing','reveal','choosing','results') ORDER BY id LIMIT 1`),
  // Questions scheduled for today-or-earlier surface first (so whoever's around has the
  // right one ready); undated questions keep normal queue order; future-dated ones wait.
  drafts: db.prepare(`SELECT * FROM questions WHERE round_id = ? AND phase = 'draft'
                       ORDER BY (scheduled_for IS NOT NULL AND scheduled_for > ?), id`),
  question: db.prepare('SELECT * FROM questions WHERE id = ?'),
  answersFor: db.prepare(`SELECT a.*, p.name, p.emoji FROM answers a JOIN players p ON p.id = a.player_id WHERE a.question_id = ? AND p.deleted = 0 ORDER BY p.name`),
  myAnswer: db.prepare('SELECT * FROM answers WHERE question_id = ? AND player_id = ?'),
  sessionQuestions: db.prepare(`SELECT * FROM questions WHERE session_id = ? AND deleted = 0 ORDER BY asked_at, id`),
  session: db.prepare(`SELECT s.*, r.topic, r.host_id AS round_host_id FROM sessions s JOIN rounds r ON r.id = s.round_id WHERE s.id = ?`),
};

// ---------- SSE ----------

const sseClients = new Set(); // entries: { res, playerId } (-1 = TV spectator)
const lastSeen = new Map();   // playerId -> ms timestamp of their last API request

function broadcast() {
  const msg = `data: ${Date.now()}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(msg); } catch { sseClients.delete(c); }
  }
}
setInterval(() => {
  for (const c of sseClients) {
    try { c.res.write(': ping\n\n'); } catch { sseClients.delete(c); }
  }
}, 25000);
// Nudge clients periodically so idle/active presence dots stay current.
setInterval(broadcast, 60000);

// ---------- state assembly ----------

// Finished questions in this round the viewer hasn't completed — their makeup queue.
// Hosts don't play, so they have no makeups.
function pendingMakeups(round, viewer) {
  if (!round || round.host_id === viewer.id) return [];
  return db.prepare(`
    SELECT qq.id, s.date,
      (SELECT COUNT(*) FROM questions q2 WHERE q2.session_id = qq.session_id AND q2.deleted = 0 AND q2.phase != 'draft'
        AND (q2.asked_at < qq.asked_at OR (q2.asked_at = qq.asked_at AND q2.id <= qq.id))) AS qnum
    FROM questions qq JOIN sessions s ON s.id = qq.session_id
    WHERE qq.round_id = ? AND qq.deleted = 0 AND qq.phase IN ('results','closed')
      AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = qq.id AND a.player_id = ? AND a.finalized = 1)
      AND NOT (qq.historical = 1 AND EXISTS (SELECT 1 FROM legacy_points lp WHERE lp.player_id = ? AND lp.date = s.date))
    ORDER BY qq.asked_at, qq.id`).all(round.id, viewer.id, viewer.id);
}

// Consecutive-scoring streaks for a player, counting back from this question
// through their finalized answers in this round (forfeits excluded).
function streaksFor(playerId, question) {
  const hist = db.prepare(`
    SELECT a.points FROM answers a JOIN questions q2 ON q2.id = a.question_id
    WHERE a.player_id = ? AND a.finalized = 1 AND a.forfeited = 0 AND q2.deleted = 0 AND q2.round_id = ?
      AND (q2.asked_at < ? OR (q2.asked_at = ? AND q2.id <= ?))
    ORDER BY q2.asked_at DESC, q2.id DESC LIMIT 40`)
    .all(playerId, question.round_id, question.asked_at, question.asked_at, question.id)
    .map(r => r.points);
  let hot = 0;
  for (const p of hist) { if (p > 0) hot++; else break; }
  let perfect = 0;
  for (const p of hist) { if (p === 2) perfect++; else break; }
  let drySnapped = 0;
  if (hist.length > 1 && hist[0] > 0) {
    for (const p of hist.slice(1)) { if (p === 0) drySnapped++; else break; }
  }
  return { hot, perfect, drySnapped };
}

function buildCallouts(rows, question) {
  const outs = [];
  const scored = rows.filter(r => r.finalized && !r.forfeited).sort((a, b) => b.points - a.points);
  for (const r of scored) {
    const { hot, perfect, drySnapped } = streaksFor(r.player_id, question);
    if (r.points === 2 && perfect >= 2) outs.push(`${r.name} stuck the landing ${perfect} in a row`);
    else if (r.points > 0 && hot >= 3) outs.push(`${r.name} is on a ${hot}-question heater`);
    else if (r.points > 0 && drySnapped >= 3) outs.push(`${r.name} snaps a ${drySnapped}-question dry spell`);
  }
  if (scored.length >= 2 && scored.every(r => r.points > 0)) outs.push('Clean sweep — everybody scored');
  return outs.slice(0, 4);
}

function questionPayload(question, viewer, isHost, hostId) {
  const phase = question.phase;
  const choices = JSON.parse(question.choices);
  const showChoices = isHost || phase === 'choosing' || phase === 'results';
  const showAnswer = isHost || phase === 'results';
  const rows = q.answersFor.all(question.id);
  const mine = rows.find(r => r.player_id === viewer.id) || null;
  // Didn't answer at all? Results stay hidden — same rule as history. Play it as a makeup
  // instead. (The TV spectator view is the shared screen, so it always shows results.)
  if (phase === 'results' && !isHost && !viewer.spectator && !mine) {
    return { id: question.id, phase, locked: true };
  }
  return {
    id: question.id,
    phase,
    text: question.text,
    roundHostId: hostId,
    choices: showChoices ? choices : null,
    correctIndex: showAnswer ? question.correct_index : null,
    answer: showAnswer ? question.answer : null,
    callouts: phase === 'results' ? buildCallouts(rows, question) : undefined,
    myAnswer: mine ? { guess: mine.guess, choiceIndex: mine.choice_index } : null,
    answers: rows.map(r => ({
      playerId: r.player_id,
      name: r.name,
      emoji: r.emoji,
      hasGuess: r.guess !== null,
      guess: (phase === 'reveal' || phase === 'choosing' || phase === 'results') ? r.guess : null,
      guessCorrect: (phase === 'results' || (isHost && phase !== 'guessing')) ? !!r.guess_correct : null,
      hasChoice: r.choice_index !== null,
      choiceIndex: phase === 'results' ? r.choice_index : null,
      points: phase === 'results' ? r.points : null,
    })),
  };
}

function buildRoundState(round, viewer) {
  const isHost = round.host_id === viewer.id;
  let session = null, question = null, todayScores = null;
  const s = q.openSession.get(round.id);
  if (s) {
    session = { id: s.id, date: s.date, status: s.status };
    const cur = q.currentQuestion.get(s.id);
    if (cur) question = questionPayload(cur, viewer, isHost, round.host_id);
    const qs = q.sessionQuestions.all(s.id);
    const scores = new Map();
    for (const qq of qs) {
      for (const a of q.answersFor.all(qq.id)) {
        if (!a.finalized) continue;
        scores.set(a.player_id, (scores.get(a.player_id) || 0) + a.points);
      }
    }
    todayScores = [...scores.entries()]
      .map(([playerId, points]) => {
        const p = q.allPlayers.all().find(x => x.id === playerId);
        return { playerId, name: p?.name, emoji: p?.emoji, points };
      })
      .sort((a, b) => b.points - a.points);
    session.questionsAsked = qs.filter(x => x.phase !== 'draft').length;
  }
  const d = q.drafts.all(round.id, todayStr());
  const drafts = isHost
    ? d.map(x => ({ id: x.id, text: x.text, answer: x.answer, choices: JSON.parse(x.choices), correctIndex: x.correct_index, scheduledFor: x.scheduled_for }))
    : { count: d.length };
  return {
    id: round.id, topic: round.topic, hostId: round.host_id, hostName: round.host_name, hostEmoji: round.host_emoji,
    isHost,
    session,
    question,
    drafts,
    todayScores,
    makeups: !viewer.spectator ? pendingMakeups(round, viewer).map(m => ({ id: m.id, date: m.date, qnum: m.qnum })) : [],
    importedPoints: isHost
      ? db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(points), 0) AS total FROM legacy_points WHERE round_id = ?').get(round.id)
      : undefined,
  };
}

function buildState(viewer) {
  const rounds = q.activeRounds.all().map(round => buildRoundState(round, viewer));
  const isHost = rounds.some(r => r.isHost);
  return {
    me: { id: viewer.id, name: viewer.name, emoji: viewer.emoji },
    isHost,
    players: q.allPlayers.all(),
    rounds,
    deletedPlayers: isHost ? q.deletedPlayers.all() : undefined,
    presence: {
      online: [...new Set([...sseClients].map(c => c.playerId).filter(id => id > 0))],
      active: [...lastSeen.entries()].filter(([, t]) => Date.now() - t < 120000).map(([id]) => id),
      tv: [...sseClients].some(c => c.playerId === -1),
    },
  };
}

// Full detail for a finished question (history / makeup-done / results archive).
function questionDetail(question, canJudge) {
  const choices = JSON.parse(question.choices);
  return {
    id: question.id,
    text: question.text,
    answer: question.answer,
    choices,
    correctIndex: question.correct_index,
    canJudge: !!canJudge,
    roundHostId: (db.prepare('SELECT host_id FROM rounds WHERE id = ?').get(question.round_id) || {}).host_id,
    historical: !!question.historical,
    covered: question.historical && question.session_id
      ? db.prepare(`SELECT p.id, p.name, p.emoji, SUM(lp.points) AS points
                    FROM legacy_points lp JOIN players p ON p.id = lp.player_id
                    WHERE lp.date = (SELECT date FROM sessions WHERE id = ?) AND p.deleted = 0
                    GROUP BY p.id ORDER BY p.name`).all(question.session_id)
      : [],
    answers: q.answersFor.all(question.id).map(r => ({
      playerId: r.player_id,
      name: r.name,
      emoji: r.emoji,
      guess: r.guess,
      guessCorrect: !!r.guess_correct,
      choiceIndex: r.choice_index,
      points: r.points,
      isMakeup: !!r.is_makeup,
      forfeited: !!r.forfeited,
    })),
  };
}

// ---------- request plumbing ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function fail(res, code, error) { json(res, code, { error }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function auth(req) {
  const url = new URL(req.url, 'http://x');
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  if (!token) return null;
  const player = q.playerByToken.get(token);
  if (player) {
    lastSeen.set(player.id, Date.now());
    return player;
  }
  if (db.prepare('SELECT token FROM spectator_tokens WHERE token = ?').get(token)) {
    return { id: -1, name: 'TV', emoji: '', spectator: true };
  }
  return null;
}

// ---------- game mutations ----------

function ensureTodaySession(round) {
  const today = todayStr();
  let s = q.openSession.get(round.id);
  if (s && s.date !== today) {
    closeSession(s); // stale from a previous day — close it out
    s = null;
  }
  if (!s) {
    db.prepare('INSERT INTO sessions (round_id, date) VALUES (?, ?)').run(round.id, today);
    s = q.openSession.get(round.id);
  }
  return s;
}

function finalizeQuestion(question) {
  // Compute + lock in points for everyone who has an answer row.
  for (const row of q.answersFor.all(question.id)) {
    const pts = computePoints(row, question);
    db.prepare('UPDATE answers SET points = ?, finalized = 1 WHERE question_id = ? AND player_id = ?')
      .run(pts, question.id, row.player_id);
  }
}

function closeSession(s) {
  for (const qq of q.sessionQuestions.all(s.id)) {
    if (qq.phase === 'results') {
      db.prepare(`UPDATE questions SET phase = 'closed' WHERE id = ?`).run(qq.id);
    } else if (qq.phase !== 'closed' && qq.phase !== 'draft') {
      finalizeQuestion(qq);
      db.prepare(`UPDATE questions SET phase = 'closed' WHERE id = ?`).run(qq.id);
    }
  }
  db.prepare(`UPDATE sessions SET status = 'closed' WHERE id = ?`).run(s.id);
}

function shuffleIn(answer, decoys) {
  const choices = [answer, ...decoys];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return { choices, correctIndex: choices.indexOf(answer) };
}

// For a backdated (historical) question, imported points on that date count as
// having played it in real life — those players are "covered".
function coveredByImport(question, playerId) {
  if (!question.historical || !question.session_id) return false;
  const s = db.prepare('SELECT date FROM sessions WHERE id = ?').get(question.session_id);
  if (!s) return false;
  return !!db.prepare('SELECT 1 FROM legacy_points WHERE player_id = ? AND date = ? LIMIT 1').get(playerId, s.date);
}

// A viewer may see a finished question's full detail if they completed it
// (played live, made it up, or forfeited), hosted that round, or are covered by imports.
function canViewDetail(question, viewer, roundHostId) {
  if (viewer.id === roundHostId) return true;
  if (coveredByImport(question, viewer.id)) return true;
  const row = q.myAnswer.get(question.id, viewer.id);
  return !!(row && row.finalized);
}

// ---------- routes ----------

const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, ...opts });
}

// --- auth ---

route('POST', /^\/api\/verify$/, async (req, res) => {
  const body = await readBody(req);
  if (body.password !== PASSWORD) return fail(res, 401, 'Wrong password');
  json(res, 200, { ok: true, players: q.allPlayers.all() });
}, { public: true });

// TV mode: password-only spectator token. Read-only live view for a shared screen.
route('POST', /^\/api\/tv$/, async (req, res) => {
  const body = await readBody(req);
  if (body.password !== PASSWORD) return fail(res, 401, 'Wrong password');
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO spectator_tokens (token) VALUES (?)').run(token);
  json(res, 200, { token });
}, { public: true });

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await readBody(req);
  if (body.password !== PASSWORD) return fail(res, 401, 'Wrong password');
  let player;
  if (body.playerId) {
    player = db.prepare('SELECT * FROM players WHERE id = ? AND deleted = 0').get(body.playerId);
    if (!player) return fail(res, 404, 'No such player');
  } else {
    const name = String(body.name || '').trim();
    if (!name || name.length > 30) return fail(res, 400, 'Name required (max 30 chars)');
    const existing = db.prepare('SELECT id FROM players WHERE lower(name) = lower(?)').get(name);
    if (existing) return fail(res, 409, 'That name is taken — pick yourself from the list instead');
    const bird = BIRD_AVATARS.has(body.avatar) ? body.avatar : '';
    db.prepare('INSERT INTO players (name, emoji) VALUES (?, ?)').run(name, bird);
    player = db.prepare('SELECT * FROM players WHERE lower(name) = lower(?)').get(name);
    broadcast();
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO tokens (token, player_id) VALUES (?, ?)').run(token, player.id);
  json(res, 200, { token, player: { id: player.id, name: player.name, emoji: player.emoji } });
}, { public: true });

// --- live state ---

route('GET', /^\/api\/state$/, (req, res, player) => {
  json(res, 200, buildState(player));
}, { spectatorOk: true });

route('GET', /^\/api\/events$/, (req, res, player) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const entry = { res, playerId: player.id };
  sseClients.add(entry);
  broadcast();
  req.on('close', () => { sseClients.delete(entry); broadcast(); });
}, { spectatorOk: true });

// Change your own bird avatar ('' goes back to initials).
route('POST', /^\/api\/avatar$/, async (req, res, player) => {
  const body = await readBody(req);
  const bird = body.avatar === '' || BIRD_AVATARS.has(body.avatar) ? body.avatar : null;
  if (bird === null) return fail(res, 400, 'No such bird');
  db.prepare('UPDATE players SET emoji = ? WHERE id = ?').run(bird, player.id);
  broadcast();
  json(res, 200, { ok: true });
});

// --- playing (live) ---

route('POST', /^\/api\/guess$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(body.roundId));
  if (!round) return fail(res, 404, 'No such round');
  if (round.host_id === player.id) return fail(res, 403, "The host doesn't play — they judge");
  const s = q.openSession.get(round.id);
  const cur = s && q.currentQuestion.get(s.id);
  if (!cur || cur.phase !== 'guessing') return fail(res, 409, 'Not accepting guesses right now');
  // Empty string = an explicit pass; still counts as participating (capped at 1 pt).
  const guess = String(body.guess || '').trim().slice(0, 200);
  db.prepare(`INSERT INTO answers (question_id, player_id, guess) VALUES (?, ?, ?)
              ON CONFLICT(question_id, player_id) DO UPDATE SET guess = excluded.guess`)
    .run(cur.id, player.id, guess);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/choice$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(body.roundId));
  if (!round) return fail(res, 404, 'No such round');
  if (round.host_id === player.id) return fail(res, 403, "The host doesn't play — they judge");
  const s = q.openSession.get(round.id);
  const cur = s && q.currentQuestion.get(s.id);
  if (!cur || cur.phase !== 'choosing') return fail(res, 409, 'Not accepting picks right now');
  const idx = Number(body.choice);
  const choices = JSON.parse(cur.choices);
  if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) return fail(res, 400, 'Bad choice');
  db.prepare(`INSERT INTO answers (question_id, player_id, choice_index) VALUES (?, ?, ?)
              ON CONFLICT(question_id, player_id) DO UPDATE SET choice_index = excluded.choice_index`)
    .run(cur.id, player.id, idx);
  broadcast();
  json(res, 200, { ok: true });
});

// --- host: rounds ---
// Any number of rounds can run at once — e.g. Eric hosting Bird Trivia and Nina hosting her
// own topic, the same day, each asking questions on their own cadence.

route('POST', /^\/api\/host\/round$/, async (req, res, player) => {
  const body = await readBody(req);
  const topic = String(body.topic || '').trim();
  if (!topic) return fail(res, 400, 'Topic required');
  const hostId = Number(body.hostId || player.id);
  if (!db.prepare('SELECT id FROM players WHERE id = ? AND deleted = 0').get(hostId)) return fail(res, 404, 'No such player');
  db.prepare('INSERT INTO rounds (topic, host_id) VALUES (?, ?)').run(topic, hostId);
  broadcast();
  json(res, 200, { ok: true });
});

// Retire a round on purpose (its host, any time) — separate now from starting a new one,
// since starting a new round no longer touches anyone else's round.
route('POST', /^\/api\/host\/round\/(\d+)\/archive$/, async (req, res, player, m) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(m[1]));
  if (!round || round.host_id !== player.id) return fail(res, 403, 'Host only');
  if (round.status !== 'active') return fail(res, 409, 'Already archived');
  const s = q.openSession.get(round.id);
  if (s) closeSession(s);
  db.prepare(`UPDATE rounds SET status = 'archived' WHERE id = ?`).run(round.id);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/round\/(\d+)\/rename$/, async (req, res, player, m) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(m[1]));
  if (!round || round.host_id !== player.id) return fail(res, 403, 'Host only');
  const body = await readBody(req);
  const topic = String(body.topic || '').trim();
  if (!topic) return fail(res, 400, 'Topic required');
  if (topic.length > 80) return fail(res, 400, 'Keep it under 80 characters');
  db.prepare('UPDATE rounds SET topic = ? WHERE id = ?').run(topic, round.id);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/transfer$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = requireHostOfRound(res, player, body.roundId);
  if (!round) return;
  if (!db.prepare('SELECT id FROM players WHERE id = ? AND deleted = 0').get(Number(body.playerId))) return fail(res, 404, 'No such player');
  db.prepare('UPDATE rounds SET host_id = ? WHERE id = ?').run(Number(body.playerId), round.id);
  broadcast();
  json(res, 200, { ok: true });
});

// --- host: questions ---

// For actions scoped to a specific round named by the client (create question, transfer,
// import, end session). Defaults to requiring the round still be active.
function requireHostOfRound(res, player, roundId, opts = {}) {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(roundId));
  if (!round || round.host_id !== player.id) { fail(res, 403, 'Host only'); return null; }
  if (opts.mustBeActive !== false && round.status !== 'active') { fail(res, 409, 'That round has been archived'); return null; }
  return round;
}

// For actions on an existing question, where the round is implied by the question itself
// (edit/delete/start/advance/recall) — a host only ever touches their own round's questions.
function hostRoundForQuestion(res, player, question) {
  if (!question) { fail(res, 404, 'No such question'); return null; }
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(question.round_id);
  if (!round || round.host_id !== player.id) { fail(res, 403, 'Host only'); return null; }
  return round;
}

// For actions that just need proof the caller hosts *something* active (player management).
function requireAnyHost(res, player) {
  const round = db.prepare(`SELECT * FROM rounds WHERE status = 'active' AND host_id = ? ORDER BY id DESC LIMIT 1`).get(player.id);
  if (!round) { fail(res, 403, 'Host only'); return null; }
  return round;
}

function parseQuestionBody(body) {
  const text = String(body.text || '').trim();
  const answer = String(body.answer || '').trim();
  const decoys = (Array.isArray(body.decoys) ? body.decoys : []).map(d => String(d).trim()).filter(Boolean);
  if (!text || !answer) return { error: 'Question and answer are required' };
  if (decoys.length < 2 || decoys.length > 4) return { error: 'Give 2–4 wrong choices' };
  return { text, answer, decoys };
}

route('POST', /^\/api\/host\/question$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = requireHostOfRound(res, player, body.roundId);
  if (!round) return;
  const parsed = parseQuestionBody(body);
  if (parsed.error) return fail(res, 400, parsed.error);
  const { choices, correctIndex } = shuffleIn(parsed.answer, parsed.decoys);
  if (body.date) {
    // Backdated: goes straight into that day's history as an already-played question.
    const date = parseImportDate(body.date);
    if (!date) return fail(res, 400, 'Bad backdate (use YYYY-MM-DD or M/D/YYYY)');
    if (date > todayStr()) return fail(res, 400, 'Backdate is in the future');
    let s = db.prepare('SELECT * FROM sessions WHERE round_id = ? AND date = ?').get(round.id, date);
    if (!s) {
      db.prepare(`INSERT INTO sessions (round_id, date, status) VALUES (?, ?, 'closed')`).run(round.id, date);
      s = db.prepare('SELECT * FROM sessions WHERE round_id = ? AND date = ?').get(round.id, date);
    }
    db.prepare(`INSERT INTO questions (round_id, session_id, text, answer, choices, correct_index, phase, historical, asked_at)
                VALUES (?, ?, ?, ?, ?, ?, 'closed', 1, ?)`)
      .run(round.id, s.id, parsed.text, parsed.answer, JSON.stringify(choices), correctIndex, `${date} 12:00:00`);
    broadcast();
    return json(res, 200, { ok: true, backdated: date });
  }
  let scheduledFor = null;
  if (body.scheduledFor) {
    scheduledFor = parseImportDate(body.scheduledFor);
    if (!scheduledFor) return fail(res, 400, 'Bad scheduled date (use YYYY-MM-DD or M/D/YYYY)');
  }
  db.prepare('INSERT INTO questions (round_id, text, answer, choices, correct_index, scheduled_for) VALUES (?, ?, ?, ?, ?, ?)')
    .run(round.id, parsed.text, parsed.answer, JSON.stringify(choices), correctIndex, scheduledFor);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/question\/(\d+)\/update$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  const round = hostRoundForQuestion(res, player, question);
  if (!round) return;
  if (question.phase !== 'draft') return fail(res, 409, 'Can only edit unasked questions');
  const body = await readBody(req);
  const parsed = parseQuestionBody(body);
  if (parsed.error) return fail(res, 400, parsed.error);
  const { choices, correctIndex } = shuffleIn(parsed.answer, parsed.decoys);
  if (body.date) {
    // Editing a draft with a backdate converts it into a historical question.
    const date = parseImportDate(body.date);
    if (!date) return fail(res, 400, 'Bad backdate (use YYYY-MM-DD or M/D/YYYY)');
    if (date > todayStr()) return fail(res, 400, 'Backdate is in the future');
    let s = db.prepare('SELECT * FROM sessions WHERE round_id = ? AND date = ?').get(round.id, date);
    if (!s) {
      db.prepare(`INSERT INTO sessions (round_id, date, status) VALUES (?, ?, 'closed')`).run(round.id, date);
      s = db.prepare('SELECT * FROM sessions WHERE round_id = ? AND date = ?').get(round.id, date);
    }
    db.prepare(`UPDATE questions SET text = ?, answer = ?, choices = ?, correct_index = ?,
                phase = 'closed', historical = 1, session_id = ?, asked_at = ? WHERE id = ?`)
      .run(parsed.text, parsed.answer, JSON.stringify(choices), correctIndex, s.id, `${date} 12:00:00`, question.id);
    broadcast();
    return json(res, 200, { ok: true, backdated: date });
  }
  let scheduledFor = null;
  if (body.scheduledFor) {
    scheduledFor = parseImportDate(body.scheduledFor);
    if (!scheduledFor) return fail(res, 400, 'Bad scheduled date (use YYYY-MM-DD or M/D/YYYY)');
  }
  db.prepare('UPDATE questions SET text = ?, answer = ?, choices = ?, correct_index = ?, scheduled_for = ? WHERE id = ?')
    .run(parsed.text, parsed.answer, JSON.stringify(choices), correctIndex, scheduledFor, question.id);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/question\/(\d+)\/delete$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  const round = hostRoundForQuestion(res, player, question);
  if (!round) return;
  if (question.phase !== 'draft') return fail(res, 409, 'Can only delete unasked questions');
  db.prepare('DELETE FROM questions WHERE id = ?').run(question.id);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/question\/(\d+)\/start$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  const round = hostRoundForQuestion(res, player, question);
  if (!round) return;
  if (round.status !== 'active') return fail(res, 409, 'That round has been archived');
  if (question.phase !== 'draft') return fail(res, 409, 'Question not startable');
  const s = ensureTodaySession(round);
  const cur = q.currentQuestion.get(s.id);
  if (cur) {
    if (cur.phase !== 'results') return fail(res, 409, 'Finish the current question first');
    db.prepare(`UPDATE questions SET phase = 'closed' WHERE id = ?`).run(cur.id);
  }
  db.prepare(`UPDATE questions SET phase = 'guessing', session_id = ?, asked_at = datetime('now') WHERE id = ?`)
    .run(s.id, question.id);
  broadcast();
  json(res, 200, { ok: true });
});

const PHASE_FLOW = { guessing: 'reveal', reveal: 'choosing', choosing: 'results' };

function advanceQuestion(question) {
  const next = PHASE_FLOW[question.phase];
  if (!next) return null;
  if (next === 'reveal') {
    // Simultaneous reveal: auto-judge every written guess (host can override, even later).
    for (const row of q.answersFor.all(question.id)) {
      if (row.guess !== null) {
        db.prepare('UPDATE answers SET guess_correct = ? WHERE question_id = ? AND player_id = ?')
          .run(autoJudge(row.guess, question), question.id, row.player_id);
      }
    }
  }
  db.prepare('UPDATE questions SET phase = ? WHERE id = ?').run(next, question.id);
  if (next === 'results') finalizeQuestion(question);
  return next;
}

route('POST', /^\/api\/host\/question\/(\d+)\/advance$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  const round = hostRoundForQuestion(res, player, question);
  if (!round) return;
  if (!advanceQuestion(question)) return fail(res, 409, 'Cannot advance from this phase');
  broadcast();
  json(res, 200, { ok: true });
});

// --- host-away (deputy) mode: any player can run the game when the host is out.
// Deputies never see answers; auto-judge grades guesses and the host can flip calls later.

route('POST', /^\/api\/deputy\/start$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(body.roundId));
  if (!round || round.status !== 'active') return fail(res, 409, 'No such active round');
  const s = ensureTodaySession(round);
  const cur = q.currentQuestion.get(s.id);
  if (cur) {
    if (cur.phase !== 'results') return fail(res, 409, 'A question is already in play');
    db.prepare(`UPDATE questions SET phase = 'closed' WHERE id = ?`).run(cur.id);
  }
  const draft = db.prepare(`SELECT * FROM questions WHERE round_id = ? AND phase = 'draft' ORDER BY id LIMIT 1`).get(round.id);
  if (!draft) return fail(res, 409, 'The question queue is empty');
  db.prepare(`UPDATE questions SET phase = 'guessing', session_id = ?, asked_at = datetime('now') WHERE id = ?`)
    .run(s.id, draft.id);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/deputy\/advance$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(Number(body.roundId));
  const s = round && q.openSession.get(round.id);
  const cur = s && q.currentQuestion.get(s.id);
  if (!cur) return fail(res, 409, 'No question in play');
  // Guard against two deputies tapping at once: the second tap no-ops.
  if (body.fromPhase && body.fromPhase !== cur.phase) return fail(res, 409, 'Someone already advanced it');
  if (!advanceQuestion(cur)) return fail(res, 409, 'Cannot advance from this phase');
  broadcast();
  json(res, 200, { ok: true });
});

// Claw back an in-progress question to the draft queue for editing.
// Guesses submitted so far are discarded — it's a full redo when re-asked.
route('POST', /^\/api\/host\/question\/(\d+)\/recall$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  const round = hostRoundForQuestion(res, player, question);
  if (!round) return;
  if (!['guessing', 'reveal', 'choosing'].includes(question.phase)) {
    return fail(res, 409, 'Can only claw back a question that is in progress');
  }
  db.prepare('DELETE FROM answers WHERE question_id = ?').run(question.id);
  db.prepare(`UPDATE questions SET phase = 'draft', session_id = NULL, asked_at = NULL WHERE id = ?`).run(question.id);
  broadcast();
  json(res, 200, { ok: true });
});

// Soft-delete an asked question: it stops counting anywhere but the rows stay in the db.
route('POST', /^\/api\/host\/question\/(\d+)\/remove$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  if (!question || question.phase === 'draft' || question.deleted) return fail(res, 404, 'No such asked question');
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(question.round_id);
  if (round.host_id !== player.id) return fail(res, 403, "Only that round's host can remove questions");
  db.prepare(`UPDATE questions SET deleted = 1, phase = 'closed' WHERE id = ?`).run(question.id);
  broadcast();
  json(res, 200, { ok: true });
});

// Import historical points: lines of "date, name, points" (comma or tab separated).
// Stored as a legacy ledger on the active round — no fake questions. Atomic: any bad line rejects the batch.
function parseImportDate(s) {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

route('POST', /^\/api\/host\/import$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = requireHostOfRound(res, player, body.roundId);
  if (!round) return;
  const lines = String(body.text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return fail(res, 400, 'Nothing to import');
  if (lines.length > 2000) return fail(res, 400, 'Too many lines (max 2000)');
  const byName = new Map(db.prepare('SELECT id, name, deleted FROM players').all().map(p => [p.name.toLowerCase(), p]));
  const errors = [];
  const rows = [];
  const toCreate = new Map();
  lines.forEach((line, i) => {
    const parts = (line.includes('\t') ? line.split('\t') : line.split(',')).map(p => p.trim());
    if (parts.length !== 3) return errors.push(`Line ${i + 1}: expected "date, name, points"`);
    const [rawDate, name, rawPts] = parts;
    const date = parseImportDate(rawDate);
    if (!date) return errors.push(`Line ${i + 1}: bad date "${rawDate}" (use YYYY-MM-DD or M/D/YYYY)`);
    const points = Number(rawPts);
    if (!Number.isInteger(points) || points < 0 || points > 1000) return errors.push(`Line ${i + 1}: bad points "${rawPts}"`);
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing && existing.deleted) return errors.push(`Line ${i + 1}: "${name}" is a deleted player — restore them first`);
    if (!existing && !toCreate.has(key)) {
      if (!body.createMissing) return errors.push(`Line ${i + 1}: no player named "${name}" (tick "create missing players" or fix the name)`);
      toCreate.set(key, name);
    }
    rows.push({ date, key, points });
  });
  if (errors.length) return fail(res, 400, errors.slice(0, 6).join(' · ') + (errors.length > 6 ? ` · (+${errors.length - 6} more)` : ''));
  for (const [key, name] of toCreate) {
    db.prepare('INSERT INTO players (name, emoji) VALUES (?, ?)').run(name, '');
    byName.set(key, db.prepare('SELECT id, name, deleted FROM players WHERE lower(name) = ?').get(key));
  }
  const ins = db.prepare('INSERT INTO legacy_points (round_id, player_id, date, points) VALUES (?, ?, ?, ?)');
  for (const r of rows) ins.run(round.id, byName.get(r.key).id, r.date, r.points);
  broadcast();
  json(res, 200, { ok: true, imported: rows.length, created: [...toCreate.values()] });
});

route('POST', /^\/api\/host\/import\/clear$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = requireHostOfRound(res, player, body.roundId);
  if (!round) return;
  const n = db.prepare('DELETE FROM legacy_points WHERE round_id = ?').run(round.id);
  broadcast();
  json(res, 200, { ok: true, deleted: n.changes });
});

// Soft-delete / restore players (e.g. test accounts). Answers stay; stats ignore them.
route('POST', /^\/api\/host\/player\/(\d+)\/delete$/, async (req, res, player, m) => {
  if (!requireAnyHost(res, player)) return;
  const target = Number(m[1]);
  if (db.prepare(`SELECT 1 FROM rounds WHERE host_id = ? AND status = 'active'`).get(target)) {
    return fail(res, 409, "Can't delete a player who's currently hosting a round");
  }
  if (!db.prepare('SELECT id FROM players WHERE id = ? AND deleted = 0').get(target)) return fail(res, 404, 'No such player');
  db.prepare('UPDATE players SET deleted = 1 WHERE id = ?').run(target);
  db.prepare('DELETE FROM tokens WHERE player_id = ?').run(target);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/player\/(\d+)\/restore$/, async (req, res, player, m) => {
  if (!requireAnyHost(res, player)) return;
  if (!db.prepare('SELECT id FROM players WHERE id = ? AND deleted = 1').get(Number(m[1]))) return fail(res, 404, 'No such deleted player');
  db.prepare('UPDATE players SET deleted = 0 WHERE id = ?').run(Number(m[1]));
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/judge$/, async (req, res, player) => {
  const body = await readBody(req);
  const question = q.question.get(Number(body.questionId));
  if (!question) return fail(res, 404, 'No such question');
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(question.round_id);
  if (round.host_id !== player.id) return fail(res, 403, 'Only that round\'s host can judge');
  const row = q.myAnswer.get(question.id, Number(body.playerId));
  if (!row || !row.guess) return fail(res, 404, 'No guess to judge');
  const correct = body.correct ? 1 : 0;
  db.prepare('UPDATE answers SET guess_correct = ? WHERE question_id = ? AND player_id = ?')
    .run(correct, question.id, row.player_id);
  if (row.finalized) {
    const updated = q.myAnswer.get(question.id, row.player_id);
    db.prepare('UPDATE answers SET points = ? WHERE question_id = ? AND player_id = ?')
      .run(computePoints(updated, question), question.id, row.player_id);
  }
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/session\/end$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = requireHostOfRound(res, player, body.roundId);
  if (!round) return;
  const s = q.openSession.get(round.id);
  if (!s) return fail(res, 409, 'No open game today');
  const cur = q.currentQuestion.get(s.id);
  if (cur && cur.phase !== 'results') return fail(res, 409, 'Finish the current question first');
  closeSession(s);
  broadcast();
  json(res, 200, { ok: true });
});

// --- history ---

route('GET', /^\/api\/history$/, (req, res, player) => {
  const playersAll = q.allPlayers.all();
  const rounds = db.prepare(`SELECT r.*, p.name AS host_name, p.emoji AS host_emoji
                             FROM rounds r JOIN players p ON p.id = r.host_id ORDER BY r.id DESC`).all();
  const hasFinalized = db.prepare('SELECT 1 FROM answers WHERE question_id = ? AND player_id = ? AND finalized = 1');
  json(res, 200, {
    rounds: rounds.map(r => ({
      id: r.id,
      topic: r.topic,
      hostName: r.host_name,
      hostEmoji: r.host_emoji,
      status: r.status,
      sessions: db.prepare(`SELECT s.id, s.date, s.status FROM sessions s WHERE s.round_id = ? ORDER BY s.date DESC, s.id DESC`).all(r.id)
        .map(s => {
          const qs = db.prepare(`SELECT * FROM questions WHERE session_id = ? AND phase != 'draft' AND deleted = 0 ORDER BY asked_at, id`).all(s.id);
          const finished = qq => qq.phase === 'results' || qq.phase === 'closed';
          // Day points: finalized answers plus imported points on this date.
          const pts = new Map();
          for (const qq of qs) {
            for (const a of q.answersFor.all(qq.id)) {
              if (a.finalized && !a.forfeited) pts.set(a.player_id, (pts.get(a.player_id) || 0) + a.points);
            }
          }
          for (const lp of db.prepare('SELECT player_id, SUM(points) AS p FROM legacy_points WHERE round_id = ? AND date = ? GROUP BY player_id').all(r.id, s.date)) {
            pts.set(lp.player_id, (pts.get(lp.player_id) || 0) + lp.p);
          }
          const pending = playersAll.filter(p =>
            p.id !== r.host_id &&
            qs.some(qq => finished(qq) && !hasFinalized.get(qq.id, p.id) && !coveredByImport(qq, p.id)));
          return {
            id: s.id,
            date: s.date,
            status: s.status,
            questionCount: qs.length,
            questions: qs.map((qq, i) => finished(qq) && canViewDetail(qq, player, r.host_id)
              ? { id: qq.id, text: qq.text }
              : { id: qq.id, index: i + 1, locked: true, canMakeup: finished(qq) && !coveredByImport(qq, player.id) }),
            points: [...pts.entries()]
              .map(([pid, points]) => {
                const p = playersAll.find(x => x.id === pid);
                return p ? { name: p.name, emoji: p.emoji, points } : null;
              })
              .filter(Boolean)
              .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)),
            pending: pending.map(p => p.name),
          };
        }),
    })),
  });
});

route('GET', /^\/api\/session\/(\d+)$/, (req, res, player, m) => {
  const s = q.session.get(Number(m[1]));
  if (!s) return fail(res, 404, 'No such session');
  const questions = q.sessionQuestions.all(s.id).filter(x => x.phase !== 'draft');
  json(res, 200, {
    id: s.id,
    date: s.date,
    status: s.status,
    topic: s.topic,
    questions: questions.map((question, i) => {
      const finished = question.phase === 'results' || question.phase === 'closed';
      if (finished && canViewDetail(question, player, s.round_host_id)) {
        return { index: i + 1, ...questionDetail(question, s.round_host_id === player.id) };
      }
      // Hidden: no unfair advantage. Text stays hidden until they play it.
      return { index: i + 1, id: question.id, locked: true, canMakeup: finished };
    }),
  });
});

// --- makeup ---

route('GET', /^\/api\/makeup\/(\d+)$/, (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  if (!question || (question.phase !== 'results' && question.phase !== 'closed')) {
    return fail(res, 409, 'Question not available for makeup');
  }
  if (coveredByImport(question, player.id)) return fail(res, 409, 'Your imported points already cover this day');
  const row = q.myAnswer.get(question.id, player.id);
  if (row && row.finalized) {
    return json(res, 200, { stage: 'done', detail: questionDetail(question, false) });
  }
  if (row && row.guess !== null) {
    // Guess is in — now they get the same reveal everyone else got, then pick.
    const others = q.answersFor.all(question.id)
      .filter(r => r.player_id !== player.id && r.guess !== null)
      .map(r => ({ name: r.name, emoji: r.emoji, guess: r.guess }));
    return json(res, 200, {
      stage: 'choose',
      text: question.text,
      myGuess: row.guess,
      choices: JSON.parse(question.choices),
      others,
    });
  }
  json(res, 200, { stage: 'guess', text: question.text });
});

route('POST', /^\/api\/makeup\/(\d+)\/guess$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  if (!question || (question.phase !== 'results' && question.phase !== 'closed')) {
    return fail(res, 409, 'Question not available for makeup');
  }
  if (coveredByImport(question, player.id)) return fail(res, 409, 'Your imported points already cover this day');
  if (q.myAnswer.get(question.id, player.id)) return fail(res, 409, 'Already started');
  const body = await readBody(req);
  const guess = String(body.guess || '').trim().slice(0, 200);
  db.prepare('INSERT INTO answers (question_id, player_id, guess, guess_correct, is_makeup) VALUES (?, ?, ?, ?, 1)')
    .run(question.id, player.id, guess, autoJudge(guess, question));
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/makeup\/(\d+)\/choice$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  if (!question) return fail(res, 404, 'No such question');
  const row = q.myAnswer.get(question.id, player.id);
  if (!row || row.guess === null || row.finalized) return fail(res, 409, 'Guess first');
  const body = await readBody(req);
  const idx = Number(body.choice);
  const choices = JSON.parse(question.choices);
  if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) return fail(res, 400, 'Bad choice');
  db.prepare('UPDATE answers SET choice_index = ?, finalized = 1 WHERE question_id = ? AND player_id = ?')
    .run(idx, question.id, player.id);
  const updated = q.myAnswer.get(question.id, player.id);
  db.prepare('UPDATE answers SET points = ? WHERE question_id = ? AND player_id = ?')
    .run(computePoints(updated, question), question.id, player.id);
  broadcast();
  json(res, 200, { ok: true, detail: questionDetail(question, false) });
});


// --- stats ---

route('GET', /^\/api\/stats$/, (req, res) => {
  const url = new URL(req.url, 'http://x');
  const roundId = url.searchParams.get('roundId');
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = dateRe.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : null;
  const to = dateRe.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : null;
  const rounds = db.prepare(`SELECT r.id, r.topic, r.status FROM rounds r ORDER BY r.id DESC`).all();
  let rows = db.prepare(`
    SELECT a.*, qq.correct_index, qq.round_id, s.date AS session_date FROM answers a
    JOIN questions qq ON qq.id = a.question_id
    LEFT JOIN sessions s ON s.id = qq.session_id
    WHERE a.finalized = 1 AND qq.deleted = 0`).all();
  if (roundId && roundId !== 'all') rows = rows.filter(r => r.round_id === Number(roundId));
  if (from) rows = rows.filter(r => r.session_date && r.session_date >= from);
  if (to) rows = rows.filter(r => r.session_date && r.session_date <= to);
  const byPlayer = new Map();
  for (const p of q.allPlayers.all()) {
    byPlayer.set(p.id, { playerId: p.id, name: p.name, emoji: p.emoji, points: 0, played: 0, answered: 0, guesses: 0, guessRight: 0, mcRight: 0, twoPointers: 0, makeups: 0, imported: 0, owed: 0 });
  }
  let legacy = db.prepare('SELECT player_id, round_id, date, points FROM legacy_points').all();
  if (roundId && roundId !== 'all') legacy = legacy.filter(r => r.round_id === Number(roundId));
  if (from) legacy = legacy.filter(r => r.date >= from);
  if (to) legacy = legacy.filter(r => r.date <= to);
  for (const r of legacy) {
    const s = byPlayer.get(r.player_id);
    if (!s) continue;
    s.points += r.points;
    s.imported += r.points;
  }
  for (const r of rows) {
    const s = byPlayer.get(r.player_id);
    if (!s) continue;
    s.points += r.points;
    if (r.forfeited) continue;
    s.answered += 1;
    s.played += 1;
    if (r.guess !== null) { s.guesses += 1; if (r.guess_correct) s.guessRight += 1; }
    if (r.choice_index === r.correct_index) s.mcRight += 1;
    if (r.points === 2) s.twoPointers += 1;
    if (r.is_makeup) s.makeups += 1;
  }
  // Backdated questions covered by imported points count as played (pre-app plays).
  let coveredRows = db.prepare(`
    SELECT DISTINCT lp.player_id, qq.id AS qid, qq.round_id, s.date
    FROM questions qq
    JOIN sessions s ON s.id = qq.session_id
    JOIN legacy_points lp ON lp.round_id = qq.round_id AND lp.date = s.date
    WHERE qq.historical = 1 AND qq.deleted = 0 AND qq.phase IN ('results','closed')`).all();
  if (roundId && roundId !== 'all') coveredRows = coveredRows.filter(r => r.round_id === Number(roundId));
  if (from) coveredRows = coveredRows.filter(r => r.date >= from);
  if (to) coveredRows = coveredRows.filter(r => r.date <= to);
  for (const c of coveredRows) {
    const s = byPlayer.get(c.player_id);
    if (s) s.played += 1;
  }
  // Outstanding makeups: finished questions in scope with no finalized answer and no coverage.
  // Broken down per round so "who owes what, where" doesn't require re-filtering to see —
  // a lumped number across concurrent rounds reads as confusing next to "Made up".
  const hostByRound = new Map(db.prepare('SELECT id, host_id FROM rounds').all().map(r => [r.id, r.host_id]));
  const topicByRound = new Map(db.prepare('SELECT id, topic FROM rounds').all().map(r => [r.id, r.topic]));
  let finishedQs = db.prepare(`
    SELECT qq.id, qq.round_id, s.date FROM questions qq JOIN sessions s ON s.id = qq.session_id
    WHERE qq.deleted = 0 AND qq.phase IN ('results','closed')`).all();
  if (roundId && roundId !== 'all') finishedQs = finishedQs.filter(r => r.round_id === Number(roundId));
  if (from) finishedQs = finishedQs.filter(r => r.date >= from);
  if (to) finishedQs = finishedQs.filter(r => r.date <= to);
  const doneSet = new Set(rows.map(r => `${r.question_id}:${r.player_id}`));
  const covSet = new Set(coveredRows.map(c => `${c.qid}:${c.player_id}`));
  for (const [pid, s] of byPlayer) {
    const owedQs = finishedQs.filter(qq =>
      hostByRound.get(qq.round_id) !== pid && !doneSet.has(`${qq.id}:${pid}`) && !covSet.has(`${qq.id}:${pid}`));
    s.owed = owedQs.length;
    const byRound = new Map();
    for (const qq of owedQs) byRound.set(qq.round_id, (byRound.get(qq.round_id) || 0) + 1);
    s.owedBreakdown = [...byRound.entries()].map(([rid, count]) => ({ roundId: rid, topic: topicByRound.get(rid), count }));
  }
  const out = [...byPlayer.values()].filter(s => s.played > 0 || s.points > 0 || s.owed > 0)
    .sort((a, b) => b.points - a.points || b.twoPointers - a.twoPointers || a.name.localeCompare(b.name));
  json(res, 200, { rounds: rounds.map(r => ({ id: r.id, topic: r.topic, status: r.status })), rows: out });
});

// ---------- static files + dispatch ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Nope');
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA-ish fallback: unknown paths get the app shell
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return fail(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.pattern);
        if (m) {
          let player = null;
          if (!r.public) {
            player = auth(req);
            if (!player) return fail(res, 401, 'Not logged in');
            if (player.spectator && !r.spectatorOk) return fail(res, 403, 'TV mode is view-only');
          }
          return await r.handler(req, res, player, m);
        }
      }
      return fail(res, 404, 'No such endpoint');
    }
    if (req.method === 'GET') return serveStatic(req, res);
    fail(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) fail(res, 500, 'Server error');
  }
});

server.listen(PORT, () => {
  console.log(`Totally Trivia running at http://localhost:${PORT}`);
  console.log(`   Team password: ${PASSWORD}${process.env.TRIVIA_PASSWORD ? '' : ' (default — set TRIVIA_PASSWORD to change)'}`);
});

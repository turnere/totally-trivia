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
  activeRound: db.prepare(`SELECT r.*, p.name AS host_name, p.emoji AS host_emoji
                           FROM rounds r JOIN players p ON p.id = r.host_id
                           WHERE r.status = 'active' ORDER BY r.id DESC LIMIT 1`),
  openSession: db.prepare(`SELECT * FROM sessions WHERE round_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`),
  currentQuestion: db.prepare(`SELECT * FROM questions WHERE session_id = ? AND deleted = 0 AND phase IN ('guessing','reveal','choosing','results') ORDER BY id LIMIT 1`),
  drafts: db.prepare(`SELECT * FROM questions WHERE round_id = ? AND phase = 'draft' ORDER BY id`),
  question: db.prepare('SELECT * FROM questions WHERE id = ?'),
  answersFor: db.prepare(`SELECT a.*, p.name, p.emoji FROM answers a JOIN players p ON p.id = a.player_id WHERE a.question_id = ? AND p.deleted = 0 ORDER BY p.name`),
  myAnswer: db.prepare('SELECT * FROM answers WHERE question_id = ? AND player_id = ?'),
  sessionQuestions: db.prepare(`SELECT * FROM questions WHERE session_id = ? AND deleted = 0 ORDER BY asked_at, id`),
  session: db.prepare(`SELECT s.*, r.topic, r.host_id AS round_host_id FROM sessions s JOIN rounds r ON r.id = s.round_id WHERE s.id = ?`),
};

// ---------- SSE ----------

const sseClients = new Set();
function broadcast() {
  const msg = `data: ${Date.now()}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 25000);

// ---------- state assembly ----------

// Finished questions in this round the viewer hasn't completed — their makeup queue.
// Hosts don't play, so they have no makeups.
function pendingMakeups(round, viewer) {
  if (!round || round.host_id === viewer.id) return [];
  return db.prepare(`
    SELECT qq.id, s.date FROM questions qq JOIN sessions s ON s.id = qq.session_id
    WHERE qq.round_id = ? AND qq.deleted = 0 AND qq.phase IN ('results','closed')
      AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = qq.id AND a.player_id = ? AND a.finalized = 1)
    ORDER BY qq.asked_at, qq.id`).all(round.id, viewer.id);
}

function questionPayload(question, viewer, isHost) {
  const phase = question.phase;
  const choices = JSON.parse(question.choices);
  const showChoices = isHost || phase === 'choosing' || phase === 'results';
  const showAnswer = isHost || phase === 'results';
  const rows = q.answersFor.all(question.id);
  const mine = rows.find(r => r.player_id === viewer.id) || null;
  // Didn't answer at all? Results stay hidden — same rule as history. Play it as a makeup instead.
  if (phase === 'results' && !isHost && !mine) {
    return { id: question.id, phase, locked: true };
  }
  return {
    id: question.id,
    phase,
    text: question.text,
    choices: showChoices ? choices : null,
    correctIndex: showAnswer ? question.correct_index : null,
    answer: showAnswer ? question.answer : null,
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

function buildState(viewer) {
  const round = q.activeRound.get() || null;
  const isHost = !!(round && round.host_id === viewer.id);
  let session = null, question = null, todayScores = null, drafts = null;
  if (round) {
    const s = q.openSession.get(round.id);
    if (s) {
      session = { id: s.id, date: s.date, status: s.status };
      const cur = q.currentQuestion.get(s.id);
      if (cur) question = questionPayload(cur, viewer, isHost);
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
    const d = q.drafts.all(round.id);
    drafts = isHost
      ? d.map(x => ({ id: x.id, text: x.text, answer: x.answer, choices: JSON.parse(x.choices), correctIndex: x.correct_index }))
      : { count: d.length };
  }
  return {
    me: { id: viewer.id, name: viewer.name, emoji: viewer.emoji },
    isHost,
    players: q.allPlayers.all(),
    round: round ? { id: round.id, topic: round.topic, hostId: round.host_id, hostName: round.host_name, hostEmoji: round.host_emoji } : null,
    session,
    question,
    drafts,
    todayScores,
    makeups: round ? pendingMakeups(round, viewer).map(m => ({ id: m.id, date: m.date })) : [],
    deletedPlayers: isHost ? q.deletedPlayers.all() : undefined,
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
  return q.playerByToken.get(token) || null;
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

// A viewer may see a finished question's full detail if they completed it
// (played live, made it up, or forfeited) — or if they hosted that round.
function canViewDetail(question, viewer, roundHostId) {
  if (viewer.id === roundHostId) return true;
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
});

route('GET', /^\/api\/events$/, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

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
  const round = q.activeRound.get();
  if (round && round.host_id === player.id) return fail(res, 403, "The host doesn't play — they judge");
  const s = round && q.openSession.get(round.id);
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
  const round = q.activeRound.get();
  if (round && round.host_id === player.id) return fail(res, 403, "The host doesn't play — they judge");
  const s = round && q.openSession.get(round.id);
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

route('POST', /^\/api\/host\/round$/, async (req, res, player) => {
  const body = await readBody(req);
  const topic = String(body.topic || '').trim();
  if (!topic) return fail(res, 400, 'Topic required');
  const hostId = Number(body.hostId || player.id);
  if (!db.prepare('SELECT id FROM players WHERE id = ? AND deleted = 0').get(hostId)) return fail(res, 404, 'No such player');
  const current = q.activeRound.get();
  if (current) {
    if (current.host_id !== player.id) return fail(res, 403, 'Only the current host can start a new round');
    const s = q.openSession.get(current.id);
    if (s) closeSession(s);
    db.prepare(`UPDATE rounds SET status = 'archived' WHERE id = ?`).run(current.id);
  }
  db.prepare('INSERT INTO rounds (topic, host_id) VALUES (?, ?)').run(topic, hostId);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/transfer$/, async (req, res, player) => {
  const body = await readBody(req);
  const round = q.activeRound.get();
  if (!round || round.host_id !== player.id) return fail(res, 403, 'Only the host can transfer hosting');
  if (!db.prepare('SELECT id FROM players WHERE id = ? AND deleted = 0').get(Number(body.playerId))) return fail(res, 404, 'No such player');
  db.prepare('UPDATE rounds SET host_id = ? WHERE id = ?').run(Number(body.playerId), round.id);
  broadcast();
  json(res, 200, { ok: true });
});

// --- host: questions ---

function requireHost(res, player) {
  const round = q.activeRound.get();
  if (!round || round.host_id !== player.id) { fail(res, 403, 'Host only'); return null; }
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
  const round = requireHost(res, player);
  if (!round) return;
  const body = await readBody(req);
  const parsed = parseQuestionBody(body);
  if (parsed.error) return fail(res, 400, parsed.error);
  const { choices, correctIndex } = shuffleIn(parsed.answer, parsed.decoys);
  db.prepare('INSERT INTO questions (round_id, text, answer, choices, correct_index) VALUES (?, ?, ?, ?, ?)')
    .run(round.id, parsed.text, parsed.answer, JSON.stringify(choices), correctIndex);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/question\/(\d+)\/update$/, async (req, res, player, m) => {
  const round = requireHost(res, player);
  if (!round) return;
  const question = q.question.get(Number(m[1]));
  if (!question || question.phase !== 'draft') return fail(res, 409, 'Can only edit unasked questions');
  const body = await readBody(req);
  const parsed = parseQuestionBody(body);
  if (parsed.error) return fail(res, 400, parsed.error);
  const { choices, correctIndex } = shuffleIn(parsed.answer, parsed.decoys);
  db.prepare('UPDATE questions SET text = ?, answer = ?, choices = ?, correct_index = ? WHERE id = ?')
    .run(parsed.text, parsed.answer, JSON.stringify(choices), correctIndex, question.id);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/question\/(\d+)\/delete$/, async (req, res, player, m) => {
  const round = requireHost(res, player);
  if (!round) return;
  const question = q.question.get(Number(m[1]));
  if (!question || question.phase !== 'draft') return fail(res, 409, 'Can only delete unasked questions');
  db.prepare('DELETE FROM questions WHERE id = ?').run(question.id);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/question\/(\d+)\/start$/, async (req, res, player, m) => {
  const round = requireHost(res, player);
  if (!round) return;
  const question = q.question.get(Number(m[1]));
  if (!question || question.round_id !== round.id || question.phase !== 'draft') return fail(res, 409, 'Question not startable');
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
route('POST', /^\/api\/host\/question\/(\d+)\/advance$/, async (req, res, player, m) => {
  const round = requireHost(res, player);
  if (!round) return;
  const question = q.question.get(Number(m[1]));
  const next = question && PHASE_FLOW[question.phase];
  if (!next) return fail(res, 409, 'Cannot advance from this phase');
  if (next === 'reveal') {
    // Simultaneous reveal: auto-judge every written guess (host can override).
    for (const row of q.answersFor.all(question.id)) {
      if (row.guess !== null) {
        db.prepare('UPDATE answers SET guess_correct = ? WHERE question_id = ? AND player_id = ?')
          .run(autoJudge(row.guess, question), question.id, row.player_id);
      }
    }
  }
  db.prepare('UPDATE questions SET phase = ? WHERE id = ?').run(next, question.id);
  if (next === 'results') finalizeQuestion(question);
  broadcast();
  json(res, 200, { ok: true });
});

// Claw back an in-progress question to the draft queue for editing.
// Guesses submitted so far are discarded — it's a full redo when re-asked.
route('POST', /^\/api\/host\/question\/(\d+)\/recall$/, async (req, res, player, m) => {
  const round = requireHost(res, player);
  if (!round) return;
  const question = q.question.get(Number(m[1]));
  if (!question || question.round_id !== round.id || !['guessing', 'reveal', 'choosing'].includes(question.phase)) {
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

// Soft-delete / restore players (e.g. test accounts). Answers stay; stats ignore them.
route('POST', /^\/api\/host\/player\/(\d+)\/delete$/, async (req, res, player, m) => {
  const round = requireHost(res, player);
  if (!round) return;
  const target = Number(m[1]);
  if (target === round.host_id) return fail(res, 409, "Can't delete the current host");
  if (!db.prepare('SELECT id FROM players WHERE id = ? AND deleted = 0').get(target)) return fail(res, 404, 'No such player');
  db.prepare('UPDATE players SET deleted = 1 WHERE id = ?').run(target);
  db.prepare('DELETE FROM tokens WHERE player_id = ?').run(target);
  broadcast();
  json(res, 200, { ok: true });
});

route('POST', /^\/api\/host\/player\/(\d+)\/restore$/, async (req, res, player, m) => {
  const round = requireHost(res, player);
  if (!round) return;
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
  const round = requireHost(res, player);
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

route('GET', /^\/api\/history$/, (req, res) => {
  const rounds = db.prepare(`SELECT r.*, p.name AS host_name, p.emoji AS host_emoji
                             FROM rounds r JOIN players p ON p.id = r.host_id ORDER BY r.id DESC`).all();
  json(res, 200, {
    rounds: rounds.map(r => ({
      id: r.id,
      topic: r.topic,
      hostName: r.host_name,
      hostEmoji: r.host_emoji,
      status: r.status,
      sessions: db.prepare(`SELECT s.id, s.date, s.status,
                              (SELECT COUNT(*) FROM questions qq WHERE qq.session_id = s.id AND qq.phase != 'draft' AND qq.deleted = 0) AS question_count
                            FROM sessions s WHERE s.round_id = ? ORDER BY s.date DESC, s.id DESC`).all(r.id)
        .map(s => ({ id: s.id, date: s.date, status: s.status, questionCount: s.question_count })),
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

route('POST', /^\/api\/makeup\/(\d+)\/forfeit$/, async (req, res, player, m) => {
  const question = q.question.get(Number(m[1]));
  if (!question || (question.phase !== 'results' && question.phase !== 'closed')) {
    return fail(res, 409, 'Question not available');
  }
  if (q.myAnswer.get(question.id, player.id)) return fail(res, 409, 'Already started — finish it instead');
  db.prepare('INSERT INTO answers (question_id, player_id, is_makeup, forfeited, finalized) VALUES (?, ?, 1, 1, 1)')
    .run(question.id, player.id);
  broadcast();
  json(res, 200, { ok: true, detail: questionDetail(question, false) });
});

// --- stats ---

route('GET', /^\/api\/stats$/, (req, res) => {
  const url = new URL(req.url, 'http://x');
  const roundId = url.searchParams.get('roundId');
  const rounds = db.prepare(`SELECT r.id, r.topic, r.status FROM rounds r ORDER BY r.id DESC`).all();
  let rows = db.prepare(`
    SELECT a.*, qq.correct_index, qq.round_id FROM answers a
    JOIN questions qq ON qq.id = a.question_id
    WHERE a.finalized = 1 AND qq.deleted = 0`).all();
  if (roundId && roundId !== 'all') rows = rows.filter(r => r.round_id === Number(roundId));
  const byPlayer = new Map();
  for (const p of q.allPlayers.all()) {
    byPlayer.set(p.id, { playerId: p.id, name: p.name, emoji: p.emoji, points: 0, played: 0, guesses: 0, guessRight: 0, mcRight: 0, twoPointers: 0, makeups: 0 });
  }
  for (const r of rows) {
    const s = byPlayer.get(r.player_id);
    if (!s) continue;
    s.points += r.points;
    if (r.forfeited) continue;
    s.played += 1;
    if (r.guess !== null) { s.guesses += 1; if (r.guess_correct) s.guessRight += 1; }
    if (r.choice_index === r.correct_index) s.mcRight += 1;
    if (r.points === 2) s.twoPointers += 1;
    if (r.is_makeup) s.makeups += 1;
  }
  const out = [...byPlayer.values()].filter(s => s.played > 0 || s.points > 0)
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

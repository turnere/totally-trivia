/* Totally Trivia — frontend. Vanilla JS, no build step. */

const $app = document.getElementById('app');

// TV mode: /tv is a read-only, big-type live view for a shared screen.
const IS_TV = location.pathname.replace(/\/+$/, '') === '/tv';
if (IS_TV) document.body.classList.add('tv');

const S = {
  token: (IS_TV ? localStorage.getItem('tt_tv_token') : localStorage.getItem('tt_token')) || null,
  me: JSON.parse(localStorage.getItem('tt_me') || 'null'),
  view: 'game',              // game | history | stats
  game: null,                // /api/state payload
  loginPlayers: null,        // player list after password verified
  loginPassword: '',
  history: null,
  sessionDetail: null,       // currently open session
  makeup: null,              // {questionId, data} active makeup flow
  stats: null,
  statsRound: 'all',
  err: {},                   // keyed error messages
};

const AV_COLORS = ['#3574e3', '#ff5050', '#3d4fd7', '#a8850b', '#1b24a2', '#797575', '#050039', '#444444'];
const BIRDS = {
  cardinal: 'Cardinal', bluejay: 'Blue Jay', owl: 'Owl', penguin: 'Penguin',
  flamingo: 'Flamingo', mallard: 'Mallard', chickadee: 'Chickadee', goldfinch: 'Goldfinch',
  toucan: 'Toucan', puffin: 'Puffin', hummingbird: 'Hummingbird', crow: 'Crow',
  falcon: 'Falcon', eagle: 'Eagle', loon: 'Loon',
};
function avatar(name, bird) {
  if (bird && BIRDS[bird]) {
    return `<img class="av-img" src="/birds/${bird}.svg" alt="${esc(BIRDS[bird])}" title="${esc(BIRDS[bird])}">`;
  }
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initial = String(name).trim().charAt(0).toUpperCase() || '?';
  return `<span class="av" style="background:${AV_COLORS[h % AV_COLORS.length]}">${esc(initial)}</span>`;
}

// ---------- api ----------

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(); throw new Error('Logged out'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function logout() {
  localStorage.removeItem(IS_TV ? 'tt_tv_token' : 'tt_token');
  localStorage.removeItem('tt_me');
  S.token = null; S.me = null; S.game = null; S.loginPlayers = null;
  if (S.sse) { S.sse.close(); S.sse = null; }
  render();
}

// ---------- live updates ----------

function connectSSE() {
  if (S.sse) S.sse.close();
  S.sse = new EventSource(`/api/events?token=${S.token}`);
  S.sse.onmessage = () => refresh();
  S.sse.onerror = () => { /* EventSource auto-reconnects */ };
}

let refreshTimer = null;
async function refresh() {
  if (!S.token) return;
  try {
    S.game = await api('/api/state');
    maybeCelebrate();
    if (S.view === 'history' && !S.makeup) {
      if (S.sessionDetail) S.sessionDetail = await api(`/api/session/${S.sessionDetail.id}`);
      else S.history = await api('/api/history');
    }
    if (S.view === 'stats') S.stats = await api(`/api/stats?roundId=${S.statsRound}`);
    render();
  } catch (e) { /* transient */ }
}
window.addEventListener('focus', refresh);

// ---------- bird background (VANTA.BIRDS, login screen only) ----------

let birdBgEffect = null;
// Enabled by default; remembers the user's choice (per-browser) once they toggle it.
let birdsEnabled = localStorage.getItem('tt_birds') !== 'off';

function ensureBirdBg(wantOn) {
  const on = wantOn && birdsEnabled;
  if (on && !birdBgEffect && window.VANTA && window.VANTA.BIRDS) {
    birdBgEffect = window.VANTA.BIRDS({
      el: '#bird-bg',
      mouseControls: true,
      touchControls: true,
      gyroControls: false,
      minHeight: 200.0,
      minWidth: 200.0,
      scale: 1.0,
      scaleMobile: 1.0,
      backgroundColor: 0xeceded,
      color1: 0xe7fed,
      color2: 0xff1010,
      colorMode: 'lerp',
      speedLimit: 7.0,
    });
    document.body.classList.add('has-bird-bg');
  } else if (!on && birdBgEffect) {
    birdBgEffect.destroy();
    birdBgEffect = null;
    document.body.classList.remove('has-bird-bg');
  }
}

function syncBirdToggleBtn() {
  const btn = document.getElementById('bird-toggle');
  if (!btn) return;
  btn.textContent = birdsEnabled ? 'Birds: on' : 'Birds: off';
  btn.classList.toggle('off', !birdsEnabled);
}

function toggleBirds() {
  birdsEnabled = !birdsEnabled;
  localStorage.setItem('tt_birds', birdsEnabled ? 'on' : 'off');
  syncBirdToggleBtn();
  render(); // re-render re-requests the birds; ensureBirdBg now honors the new preference
}

// ---------- confetti ----------

function confettiBurst(points) {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#3574e3', '#ff5050', '#ffcc01', '#3d4fd7', '#ffbab9', '#1b24a2'];
  const parts = Array.from({ length: 70 + points * 40 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.3,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 16,
    vy: -Math.random() * 15 - 5,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frames = 0;
  (function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (++frames < 160) requestAnimationFrame(tick);
    else canvas.remove();
  })();
}

// Fire once per question when results land and I scored. Two-pointers get an encore.
// The TV celebrates whenever anyone scored.
function maybeCelebrate() {
  const qq = S.game && S.game.question;
  if (!qq || qq.phase !== 'results' || qq.locked || S.celebratedQ === qq.id) return;
  S.celebratedQ = qq.id;
  if (IS_TV) {
    const best = Math.max(0, ...(qq.answers || []).map(a => a.points || 0));
    if (best > 0) {
      confettiBurst(best);
      if (best === 2) setTimeout(() => confettiBurst(2), 450);
    }
    return;
  }
  const mine = (qq.answers || []).find(a => a.playerId === S.game.me.id);
  if (mine && mine.points > 0) {
    confettiBurst(mine.points);
    if (mine.points === 2) setTimeout(() => confettiBurst(2), 450);
  }
}

// ---------- input preservation across re-renders ----------

const draftValues = {};
document.addEventListener('input', (e) => {
  if (e.target.id) draftValues[e.target.id] = e.target.value;
});
function val(id) { return draftValues[id] || ''; }
function clearVal(...ids) { ids.forEach(id => delete draftValues[id]); }

function restoreFocus(focusedId, selStart) {
  if (!focusedId) return;
  const el = document.getElementById(focusedId);
  if (el) {
    el.focus();
    try { el.setSelectionRange(selStart, selStart); } catch {}
  }
}

// ---------- rendering ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Animations replay only when the question/phase actually changes, not on every
// SSE refresh — track a phase key and mark the render "fresh" on transitions.
function checkAnimFresh() {
  const qq = S.game && S.game.question;
  const key = qq ? `${qq.id}:${qq.phase}:${qq.locked ? 1 : 0}` : 'idle';
  S.animFresh = key !== S.renderedPhaseKey;
  S.renderedPhaseKey = key;
}

function render() {
  const focused = document.activeElement;
  const focusedId = focused && focused.id && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA') ? focused.id : null;
  const selStart = focusedId ? focused.selectionStart : 0;

  if (IS_TV) { renderTV(); restoreFocus(focusedId, selStart); return; }
  ensureBirdBg(true); // the flock flies on every screen now
  if (!S.token) {
    $app.innerHTML = renderLogin();
    document.body.classList.remove('spotlight');
    restoreFocus(focusedId, selStart);
    return;
  }
  if (!S.game) { $app.innerHTML = '<div class="empty">Loading…</div>'; return; }

  const g = S.game;
  // Spotlight is a layout choice (center the live question, hide the sidebar) — independent
  // of the birds, which are always on now.
  const spotlight = S.view === 'game' && !!g.question && g.question.phase === 'guessing' && !g.question.locked;
  document.body.classList.toggle('spotlight', spotlight);
  $app.innerHTML = `
    <header>
      <div class="logo">Totally <span>Trivia</span></div>
      ${g.round ? `<div class="topic">${esc(g.round.topic)}</div>` : ''}
      <div class="spacer"></div>
      <div class="whoami">
        <button class="ghost" onclick="S.showBirdPicker=!S.showBirdPicker;render()" title="Change your bird">${avatar(g.me.name, g.me.emoji)} ${esc(g.me.name)}</button>${g.isHost ? '<b>host</b>' : ''}
        <button class="ghost" onclick="logout()">log out</button>
      </div>
    </header>
    ${S.showBirdPicker ? renderBirdPicker() : ''}
    <nav class="tabs">
      ${['game', 'history', 'stats'].map(v =>
        `<button class="${S.view === v ? 'active' : ''}" onclick="setView('${v}')">${{ game: 'Play', history: 'History', stats: 'Stats' }[v]}</button>`).join('')}
    </nav>
    ${S.view === 'game' ? renderGame() : S.view === 'history' ? renderHistory() : renderStats()}
  `;
  restoreFocus(focusedId, selStart);
}

function renderBirdPicker() {
  const mine = S.game.me.emoji || '';
  return `<div class="card">
    <h2>Pick your bird</h2>
    <div class="bird-grid">
      ${Object.entries(BIRDS).map(([slug, label]) => `<button class="${mine === slug ? 'sel' : ''}" onclick="setMyBird('${slug}')"><img src="/birds/${slug}.svg" alt="${label}">${label}</button>`).join('')}
      <button class="${mine === '' ? 'sel' : ''}" onclick="setMyBird('')">${avatar(S.game.me.name, '')}No bird (initials)</button>
    </div>
  </div>`;
}

function setMyBird(bird) {
  act(async () => {
    await api('/api/avatar', { avatar: bird });
    S.showBirdPicker = false;
  });
}

function setView(v) {
  S.view = v;
  if (v === 'history') { S.sessionDetail = null; S.makeup = null; loadHistory(); }
  if (v === 'stats') loadStats();
  render();
}

// ---------- TV mode ----------

function renderTV() {
  ensureBirdBg(true); // the flock flies on every screen now
  if (!S.token) {
    $app.innerHTML = `<div class="login-wrap">
      <h1>Totally Trivia</h1>
      <p class="sub">TV mode — a live view for the big screen. Nobody plays from here.</p>
      <div class="card">
        <label for="pw">Team password</label>
        <input type="password" id="pw" placeholder="password" onkeydown="if(event.key==='Enter')tvLogin()">
        <div class="err">${esc(S.err.login || '')}</div>
        <button class="primary big" style="width:100%" onclick="tvLogin()">Start the show</button>
      </div>
    </div>`;
    return;
  }
  if (!S.game) { $app.innerHTML = '<div class="empty">Loading…</div>'; return; }
  checkAnimFresh();
  const g = S.game;
  const qq = g.question;
  const main = !g.round
    ? '<div class="card empty">No round yet — waiting for a host.</div>'
    : !qq
      ? tvIdle()
      : ({ guessing: tvGuessing, reveal: tvReveal, choosing: tvChoosing, results: tvResults }[qq.phase] || tvIdle)(qq);
  $app.innerHTML = `
    <header>
      <div class="logo">Totally <span>Trivia</span></div>
      ${g.round ? `<div class="topic">${esc(g.round.topic)}</div>` : ''}
      <div class="spacer"></div>
      <div class="whoami muted">TV mode</div>
    </header>
    <div class="game-layout">
      <div class="${S.animFresh ? 'anim' : ''}">${main}</div>
      <div>${renderScoreboard()}${renderPresenceCard()}</div>
    </div>`;
}

async function tvLogin() {
  try {
    S.err.login = '';
    const r = await api('/api/tv', { password: document.getElementById('pw').value });
    S.token = r.token;
    localStorage.setItem('tt_tv_token', r.token);
    connectSSE();
    await refresh();
  } catch (e) { S.err.login = e.message; render(); }
}

function tvIdle() {
  const g = S.game;
  return `<div class="card empty" style="padding:60px 20px">
    <div class="question-text" style="margin-bottom:8px">Waiting for ${esc(g.round.hostName)} to launch the next question</div>
    ${typeof g.drafts?.count === 'number' && g.drafts.count > 0 ? `<p class="muted">${g.drafts.count} question${g.drafts.count > 1 ? 's' : ''} in the queue</p>` : ''}
  </div>`;
}

function tvGuessing(qq) {
  return `<div class="card">
    <span class="phase-tag guessing">Guessing time — answers are hidden</span>
    <div class="question-text">${esc(qq.text)}</div>
    ${playerChips(qq, a => a.hasGuess, 'guesses in')}
  </div>`;
}

function tvReveal(qq) {
  return `<div class="card">
    <span class="phase-tag reveal">The reveal</span>
    <div class="question-text">${esc(qq.text)}</div>
    ${qq.answers.filter(a => a.hasGuess).length ? `<div class="guess-grid">
      ${qq.answers.filter(a => a.hasGuess).map(a => `
        <div class="guess-card ${a.guessCorrect === true ? 'right' : ''}">
          <div class="who">${avatar(a.name, a.emoji)} ${esc(a.name)}</div>
          <div class="what">${a.guess === '' ? '<span class="muted">(passed)</span>' : esc(a.guess)}</div>
        </div>`).join('')}
    </div>` : '<p class="muted">Nobody guessed. Tough crowd.</p>'}
  </div>`;
}

function tvChoosing(qq) {
  return `<div class="card">
    <span class="phase-tag choosing">Multiple choice — stick with your guess for 2</span>
    <div class="question-text">${esc(qq.text)}</div>
    <div class="choices">
      ${qq.choices.map((c, i) => `<button class="static"><span class="letter">${'ABCD'[i] || i + 1}</span> ${esc(c)}</button>`).join('')}
    </div>
    ${playerChips(qq, a => a.hasChoice, 'locked in')}
  </div>`;
}

function tvResults(qq) {
  return `<div class="card">
    <span class="phase-tag results">Results</span>
    <div class="question-text">${esc(qq.text)}</div>
    <div class="answer-banner">Answer: <b>${esc(qq.answer)}</b></div>
    ${callouts(qq)}
    ${resultsTable(qq, false)}
  </div>`;
}

// ---------- login ----------

function renderLogin() {
  if (!S.loginPlayers) {
    return `<div class="login-wrap">
      <h1>Totally Trivia</h1>
      <p class="sub">Morning standup trivia. Guess first, stick the landing.</p>
      <div class="card">
        <label for="pw">Team password</label>
        <input type="password" id="pw" placeholder="password" onkeydown="if(event.key==='Enter')doVerify()">
        <div class="err">${esc(S.err.login || '')}</div>
        <button class="primary big" style="width:100%" onclick="doVerify()">Let me in</button>
      </div>
    </div>`;
  }
  return `<div class="login-wrap">
    <h1>Who are you?</h1>
    <p class="sub">Pick yourself, or add yourself below.</p>
    <div class="card">
      ${S.loginPlayers.length ? `<div class="player-grid">
        ${S.loginPlayers.map(p => `<button onclick="doLogin(${p.id})">${avatar(p.name, p.emoji)}${esc(p.name)}</button>`).join('')}
      </div><hr style="border:none;border-top:1px dashed var(--line);margin:14px 0">` : ''}
      <h3>New player</h3>
      <input type="text" id="newname" placeholder="Your name" value="${esc(val('newname'))}" onkeydown="if(event.key==='Enter')doCreate()">
      <label class="mt">Pick your bird (optional — you can change it later)</label>
      <div class="bird-grid">
        ${Object.entries(BIRDS).map(([slug, label]) => `<button class="${S.newBird === slug ? 'sel' : ''}" onclick="S.newBird=S.newBird==='${slug}'?null:'${slug}';render()"><img src="/birds/${slug}.svg" alt="${label}">${label}</button>`).join('')}
      </div>
      <button class="primary mt" style="width:100%" onclick="doCreate()">Join</button>
      <div class="err">${esc(S.err.login || '')}</div>
    </div>
  </div>`;
}

async function doVerify() {
  try {
    S.err.login = '';
    const pw = document.getElementById('pw').value;
    const r = await api('/api/verify', { password: pw });
    S.loginPassword = pw;
    S.loginPlayers = r.players;
  } catch (e) { S.err.login = e.message; }
  render();
}

async function finishLogin(r) {
  S.token = r.token; S.me = r.player;
  localStorage.setItem('tt_token', r.token);
  localStorage.setItem('tt_me', JSON.stringify(r.player));
  S.loginPlayers = null; S.err.login = '';
  clearVal('pw', 'newname');
  connectSSE();
  await refresh();
}

async function doLogin(playerId) {
  try { await finishLogin(await api('/api/login', { password: S.loginPassword, playerId })); }
  catch (e) { S.err.login = e.message; render(); }
}

async function doCreate() {
  try {
    const name = document.getElementById('newname').value.trim();
    await finishLogin(await api('/api/login', { password: S.loginPassword, name, avatar: S.newBird || '' }));
  } catch (e) { S.err.login = e.message; render(); }
}

// ---------- game view ----------

function renderGame() {
  const g = S.game;
  if (!g.round) return renderNoRound();

  checkAnimFresh();
  const qq = g.question;

  // The moment a question starts: just the question, centered, birds behind it.
  // Everything else (scoreboard, host desk) steps aside until the reveal.
  if (qq && qq.phase === 'guessing' && !qq.locked) {
    return `<div class="spotlight-stage ${S.animFresh ? 'anim' : ''}">${renderGuessing(qq)}</div>`;
  }

  // A question in results is over: lead with "what's next", recap the results below.
  const inResults = qq && qq.phase === 'results';
  const live = qq && !inResults ? renderQuestion() : '';
  const between = !qq || inResults ? renderBetweenQuestions() : '';
  const recent = inResults ? (qq.locked ? renderLockedResults(qq, true) : renderResults(qq, true)) : '';
  return `<div class="game-layout">
    <div class="${S.animFresh ? 'anim' : ''}">${live}${between}${g.isHost ? renderHostTools() : ''}${recent}</div>
    <div>${renderScoreboard()}${renderPresenceCard()}${renderMakeupsCard()}</div>
  </div>`;
}

function presenceOf(id) {
  const pr = S.game.presence || {};
  const online = (pr.online || []).includes(id);
  const active = (pr.active || []).includes(id);
  if (active) return 'on';
  if (online) return 'idle';
  return 'off';
}

function renderPresenceCard() {
  const g = S.game;
  if (!g.players.length) return '';
  return `<div class="card">
    <h2>Who's here</h2>
    <ul class="scoreboard">
      ${g.players.map(p => {
        const st = presenceOf(p.id);
        return `<li>${avatar(p.name, p.emoji)} ${esc(p.name)}
          <span class="presdot ${st}" style="margin-left:auto" title="${st === 'on' ? 'here and active' : st === 'idle' ? 'connected, idle' : 'offline'}"></span></li>`;
      }).join('')}
    </ul>
    ${g.presence && g.presence.tv ? '<p class="small muted mt">TV screen connected</p>' : ''}
  </div>`;
}

function renderMakeupsCard() {
  const list = S.game.makeups || [];
  if (!list.length) return '';
  return `<div class="card">
    <h2>Your makeups (${list.length})</h2>
    <p class="small muted">Questions you missed in ${esc(S.game.round.topic)}. Their answers stay hidden until you play them.</p>
    <ul class="scoreboard">
      ${list.map(m => `<li>${esc(m.date)} · Question ${m.qnum}<span style="margin-left:auto"><button onclick="playMakeup(${m.id})">Play</button></span></li>`).join('')}
    </ul>
  </div>`;
}

async function playMakeup(qid) {
  S.makeupReturn = 'game';
  S.view = 'history';
  S.sessionDetail = null;
  await startMakeup(qid);
}

function renderNoRound() {
  return `<div class="card">
    <h2>No round yet</h2>
    <p class="muted">Kick things off — whoever creates the round becomes its host.</p>
    <div class="mt">
      <label for="topic0">Topic</label>
      <input type="text" id="topic0" placeholder="e.g. Bird Trivia" value="${esc(val('topic0'))}">
      <div class="err">${esc(S.err.round || '')}</div>
      <button class="primary" onclick="createRound('topic0')">Start the round</button>
    </div>
  </div>`;
}

function renderScoreboard() {
  const g = S.game;
  const rows = g.todayScores || [];
  return `<div class="card">
    <h2>Today${g.session ? ` · ${esc(g.session.date)}` : ''}</h2>
    ${rows.length ? `<ul class="scoreboard">
      ${rows.map((r, i) => `<li><span class="pos">${i + 1}</span>${avatar(r.name, r.emoji)} ${esc(r.name)}
        <span class="pts ${r.points >= 2 ? 'two' : r.points ? 'one' : 'zero'}">${r.points}</span></li>`).join('')}
    </ul>` : '<p class="muted small">No points yet today.</p>'}
    <p class="small muted mt">Host: ${esc(g.round.hostName)}</p>
  </div>`;
}

function renderBetweenQuestions() {
  const g = S.game;
  if (g.isHost) return ''; // host sees their tools below
  const queued = typeof g.drafts?.count === 'number' ? g.drafts.count : 0;
  return `<div class="card empty">
    Waiting for ${esc(g.round.hostName)} to launch the next question…
    ${queued > 0 ? `<p class="small mt">${queued} question${queued > 1 ? 's' : ''} in the queue</p>
    <p class="mt"><button onclick="deputyStart()">Host away? Start the next question</button></p>` : ''}
  </div>`;
}

function deputyBar(fromPhase, label) {
  if (S.game.isHost) return '';
  return `<div class="mt" style="text-align:right"><button class="ghost" onclick="deputyAdv('${fromPhase}')">Host away? ${label}</button></div>`;
}

function deputyStart() {
  if (!confirm('Start the next question without the host? Guesses get auto-judged; the host can fix close calls later from History.')) return;
  act(() => api('/api/deputy/start', {}));
}

function deputyAdv(fromPhase) {
  if (!confirm('Advance the game for everyone?')) return;
  act(() => api('/api/deputy/advance', { fromPhase }));
}

function renderQuestion() {
  const qq = S.game.question;
  if (qq.locked) return renderLockedResults(qq, false);
  const fn = { guessing: renderGuessing, reveal: renderReveal, choosing: renderChoosing, results: renderResults }[qq.phase];
  return fn ? fn(qq) : '';
}

function renderLockedResults(qq, recent) {
  return `<div class="card">
    <span class="phase-tag results">${recent ? 'Last question' : 'Results'}</span>
    <div class="locked-q" style="margin-top:12px">
      You didn't get an answer in for this one, so the results are hidden.
      <div class="row mt" style="justify-content:center">
        <button class="primary" onclick="playMakeup(${qq.id})">Play it now</button>
      </div>
    </div>
  </div>`;
}

function playerChips(qq, doneFn, verb) {
  return `<div class="waiting-list">
    ${S.game.players.filter(p => p.id !== S.game.round.hostId).map(p => {
      const a = qq.answers.find(x => x.playerId === p.id);
      const done = a && doneFn(a);
      return `<span class="chip ${done ? 'done' : ''}">${avatar(p.name, p.emoji)} ${esc(p.name)} <span class="presdot ${presenceOf(p.id)}"></span> ${done ? '<span class="tick">✓</span>' : ''}</span>`;
    }).join('')}
  </div>
  <p class="small muted mt">${qq.answers.filter(doneFn).length} ${verb}</p>`;
}

function renderGuessing(qq) {
  const mine = qq.myAnswer ? qq.myAnswer.guess : null;
  const hasMine = mine !== null && mine !== undefined;
  return `<div class="card">
    <span class="phase-tag guessing">Write your guess</span>
    <div class="question-text">${esc(qq.text)}</div>
    ${S.game.isHost ? '<p class="small muted">Read it out — you judge, you don\'t play.</p>' : `<div class="row">
      <input type="text" id="guess" class="grow" placeholder="Your guess — nobody sees it until the reveal"
        value="${esc(val('guess') || mine || '')}" onkeydown="if(event.key==='Enter')submitGuess()">
      <button class="primary" onclick="submitGuess()">${hasMine ? 'Update' : 'Lock it in'}</button>
      <button onclick="passGuess()" title="Skip the written guess — you can still answer the multiple choice for 1 point">Pass</button>
    </div>
    ${hasMine ? `<p class="small muted mt">Your guess is in: <b>${mine === '' ? '(passed)' : esc(mine)}</b> — you can change it until the reveal.</p>` : ''}
    <div class="err">${esc(S.err.game || '')}</div>`}
    ${playerChips(qq, a => a.hasGuess, 'guesses in')}
    ${hostAdvance(qq, 'guessing', 'Reveal all guesses')}
    ${deputyBar('guessing', 'Reveal all guesses')}
  </div>`;
}

function renderReveal(qq) {
  const isHost = S.game.isHost;
  return `<div class="card">
    <span class="phase-tag reveal">The reveal</span>
    <div class="question-text">${esc(qq.text)}</div>
    ${qq.answers.filter(a => a.hasGuess).length ? `<div class="guess-grid">
      ${qq.answers.filter(a => a.hasGuess).map(a => `
        <div class="guess-card ${a.guessCorrect === true ? 'right' : ''}">
          <div class="who">${avatar(a.name, a.emoji)} ${esc(a.name)}</div>
          <div class="what">${a.guess === '' ? '<span class="muted">(passed)</span>' : esc(a.guess)}</div>
          ${isHost && a.guess !== '' ? `<div class="judge-btns">
            <button class="${a.guessCorrect ? 'on-right' : ''}" title="Mark correct" onclick="judge(${qq.id},${a.playerId},true)">✓</button>
            <button class="${a.guessCorrect === false ? 'on-wrong' : ''}" title="Mark wrong" onclick="judge(${qq.id},${a.playerId},false)">✗</button>
          </div>` : ''}
        </div>`).join('')}
    </div>` : '<p class="muted">Nobody guessed! Tough crowd.</p>'}
    ${isHost ? `<p class="small muted mt">Green = counts as a correct guess (auto-judged — fix any I got wrong). Answer: <b>${esc(qq.answer)}</b></p>` : ''}
    ${hostAdvance(qq, 'reveal', 'Open multiple choice')}
    ${deputyBar('reveal', 'Open multiple choice')}
  </div>`;
}

function renderChoosing(qq) {
  const mine = qq.myAnswer?.choiceIndex;
  const myGuess = qq.myAnswer?.guess;
  return `<div class="card">
    <span class="phase-tag choosing">Multiple choice — stick with your guess for 2</span>
    <div class="question-text">${esc(qq.text)}</div>
    ${myGuess != null ? `<p class="small muted" style="margin-bottom:10px">You guessed: <b>${myGuess === '' ? '(passed)' : esc(myGuess)}</b></p>` : ''}
    <div class="choices">
      ${qq.choices.map((c, i) => `
        <button class="${mine === i ? 'mine' : ''} ${S.game.isHost ? 'static' : ''} ${S.game.isHost && qq.correctIndex === i ? 'host-correct' : ''}" ${S.game.isHost ? '' : `onclick="submitChoice(${i})"`}>
          <span class="letter">${'ABCD'[i] || i + 1}</span> ${esc(c)}
        </button>`).join('')}
    </div>
    <div class="err">${esc(S.err.game || '')}</div>
    ${playerChips(qq, a => a.hasChoice, 'locked in')}
    ${hostAdvance(qq, 'choosing', 'Show results')}
    ${deputyBar('choosing', 'Show results')}
  </div>`;
}

function resultRow(a, qq, canJudge) {
  const choiceTxt = a.forfeited ? '<span class="muted">skipped</span>'
    : a.choiceIndex === null || a.choiceIndex === undefined ? '<span class="muted">—</span>'
    : `${esc(qq.choices[a.choiceIndex])} ${a.choiceIndex === qq.correctIndex ? '<span class="mark-right">✓</span>' : '<span class="mark-wrong">✗</span>'}`;
  const guessTxt = a.guess === null || a.guess === undefined ? '<span class="muted">—</span>'
    : a.guess === '' ? '<span class="muted">(passed)</span>'
    : `${esc(a.guess)} ${a.guessCorrect ? '<span class="mark-right">✓</span>' : '<span class="mark-wrong">✗</span>'}`;
  return `<tr>
    <td>${avatar(a.name, a.emoji)} ${esc(a.name)} ${a.isMakeup ? '<span class="badge makeup">makeup</span>' : ''}</td>
    <td>${guessTxt}
      ${canJudge && a.guess ? `<button class="ghost small" onclick="judge(${qq.id},${a.playerId},${!a.guessCorrect})">flip</button>` : ''}</td>
    <td>${choiceTxt}</td>
    <td><span class="pts ${a.points === 2 ? 'two' : a.points === 1 ? 'one' : 'zero'}">+${a.points ?? 0}</span>
      ${a.points > 0 ? '<img src="/parrot.gif" class="parrot" alt="party parrot">'.repeat(a.points) : ''}</td>
  </tr>`;
}

// Full results table: everyone who answered, then anyone who missed it (makeup pending).
function resultsTable(qq, canJudge) {
  const hostId = qq.roundHostId ?? S.game.round?.hostId;
  const covered = qq.covered || [];
  const missed = S.game.players.filter(p =>
    p.id !== hostId && !qq.answers.some(a => a.playerId === p.id) && !covered.some(c => c.id === p.id));
  return `<table class="results">
    <tr><th>Player</th><th>Written guess</th><th>Multiple choice</th><th>Points</th></tr>
    ${qq.answers.map(a => resultRow(a, qq, canJudge)).join('')}
    ${covered.map(p => `<tr>
      <td>${avatar(p.name, p.emoji)} ${esc(p.name)} <span class="badge">pre-app</span></td>
      <td colspan="2"><span class="muted">played before the app</span></td>
      <td><span class="pts ${p.points >= 2 ? 'two' : p.points ? 'one' : 'zero'}">+${p.points}</span>${'<img src="/parrot.gif" class="parrot" alt="party parrot">'.repeat(Math.min(p.points, 4))}
        <span class="muted small">that day</span></td>
    </tr>`).join('')}
    ${missed.map(p => `<tr>
      <td>${avatar(p.name, p.emoji)} ${esc(p.name)} <span class="badge makeup">missed</span></td>
      <td><span class="muted">—</span></td>
      <td><span class="muted">—</span></td>
      <td><span class="muted small">makeup pending</span></td>
    </tr>`).join('')}
  </table>`;
}

function callouts(qq) {
  if (!qq.callouts || !qq.callouts.length) return '';
  return `<div class="callouts">${qq.callouts.map(c => `<div class="callout">${esc(c)}</div>`).join('')}</div>`;
}

function renderResults(qq, recent) {
  return `<div class="card">
    <span class="phase-tag results">${recent ? 'Last question' : 'Results'}</span>
    <div class="question-text">${esc(qq.text)}</div>
    <div class="answer-banner">Answer: <b>${esc(qq.answer)}</b></div>
    ${callouts(qq)}
    ${resultsTable(qq, S.game.isHost)}
    ${S.game.isHost ? `<div class="mt row">
      <span class="small muted grow">Wrong call on a guess? Hit “flip” — points recalculate.</span>
      <button class="ghost danger" onclick="removeQ(${qq.id})" title="Botched question? Scrap it — it won't count for anyone">Scrap this question</button>
    </div>` : ''}
  </div>`;
}

function hostAdvance(qq, phase, label) {
  if (!S.game.isHost) return '';
  return `<div class="mt row">
    <button class="primary big" onclick="advance(${qq.id})">${label}</button>
    <span class="grow"></span>
    <button class="ghost" onclick="recallQ(${qq.id})" title="Pull it back into the queue to fix the wording or choices — guesses so far are discarded">Claw back &amp; edit</button>
    <button class="ghost danger" onclick="removeQ(${qq.id})" title="Botched question? Scrap it — it won't count for anyone">Scrap this question</button>
  </div>`;
}

// ---------- host tools ----------

function renderHostTools() {
  const g = S.game;
  const inQuestion = !!g.question;
  const drafts = Array.isArray(g.drafts) ? g.drafts : [];
  const editing = S.editingDraft;
  return `<div class="card">
    <h2>Host desk</h2>
    ${drafts.length ? `<h3>Question queue</h3>
      ${drafts.map(d => `<div class="draft-item">
        <div class="q">${esc(d.text)}<div class="a muted small">answer hidden — Edit to view</div></div>
        <button class="primary" ${inQuestion && g.question.phase !== 'results' ? 'disabled title="Finish the current question first"' : ''}
          onclick="startQ(${d.id})">Ask it</button>
        <button onclick="editDraft(${d.id})">Edit</button>
        <button class="danger" onclick="deleteQ(${d.id})">Delete</button>
      </div>`).join('')}` : '<p class="muted small">Queue is empty — add a question below.</p>'}

    <details class="host-tools" ${drafts.length === 0 || editing ? 'open' : ''}>
      <summary>${editing ? 'Edit question' : 'Add a question'}</summary>
      <div>
        <label for="qtext">Question</label>
        <input type="text" id="qtext" placeholder="What bird can fly backwards?" value="${esc(val('qtext'))}">
        <label class="mt" for="qanswer">Correct answer</label>
        <input type="text" id="qanswer" placeholder="Hummingbird" value="${esc(val('qanswer'))}">
        <label class="mt">Wrong choices (2–4, they get shuffled with the answer)</label>
        <div class="decoy-inputs">
          ${[0, 1, 2, 3].map(i => `<input type="text" id="decoy${i}" placeholder="Decoy ${i + 1}${i > 1 ? ' (optional)' : ''}" value="${esc(val('decoy' + i))}">`).join('')}
        </div>
        <label class="mt" for="qdate">Backdate (optional)</label>
        <input type="text" id="qdate" placeholder="YYYY-MM-DD — recreate a question from before the app" value="${esc(val('qdate'))}">
        <p class="small muted">Leave blank to queue it normally. With a date, it goes straight into that day's History as already played — people with imported points on that date are covered; everyone else gets it as a makeup.</p>
        <div class="err">${esc(S.err.host || '')}</div>
        ${S.hostMsg ? `<p class="small" style="color:var(--accent)">${esc(S.hostMsg)}</p>` : ''}
        <div class="row">
          <button class="primary" onclick="saveQuestion()">${editing ? 'Save changes' : 'Add to queue'}</button>
          ${editing ? '<button onclick="cancelEdit()">Cancel</button>' : ''}
        </div>
      </div>
    </details>

    <details class="host-tools">
      <summary>Round controls</summary>
      <div>
        ${g.session ? `<button onclick="endSession()">End today's game</button>` : '<p class="muted small">Today\'s game starts automatically when you ask the first question.</p>'}
        <div class="mt">
          <label>Hand hosting of <b>${esc(g.round.topic)}</b> to…</label>
          <div class="row">
            <select id="transferSel" class="grow">${g.players.filter(p => p.id !== g.me.id).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
            <button onclick="transferHost()">Transfer</button>
          </div>
        </div>
        <div class="mt">
          <label>Manage players</label>
          ${g.players.filter(p => p.id !== g.round.hostId).map(p => `<div class="row" style="margin-bottom:6px">${avatar(p.name, p.emoji)}<span class="grow">${esc(p.name)}</span><button class="danger" onclick="deletePlayer(${p.id})">Delete</button></div>`).join('') || '<p class="muted small">Nobody else has joined yet.</p>'}
          ${(g.deletedPlayers || []).map(p => `<div class="row" style="margin-bottom:6px"><span class="grow muted">${esc(p.name)} (deleted)</span><button onclick="restorePlayer(${p.id})">Restore</button></div>`).join('')}
          <p class="small muted">Deleting is soft: they vanish from the game and stats, but their answers are kept and restoring brings everything back.</p>
        </div>
        <div class="mt">
          <label>Import old points</label>
          <p class="small muted">One entry per line: <b>date, name, points</b> — commas or tabs, so pasting from a spreadsheet works. Dates like 2026-06-12 or 6/12/2026. Lands in this round's stats as imported points.</p>
          <textarea id="importText" rows="5" placeholder="2026-06-12, Nina, 2&#10;2026-06-12, Eric, 1">${esc(val('importText'))}</textarea>
          <div class="row mt">
            <label class="row small" style="font-weight:400;width:auto"><input type="checkbox" id="importCreate" ${S.importCreate ? 'checked' : ''} onchange="S.importCreate=this.checked"> create missing players</label>
            <button onclick="importPoints()">Import</button>
          </div>
          ${g.importedPoints && g.importedPoints.count ? `<p class="small muted">This round has ${g.importedPoints.count} imported entries worth ${g.importedPoints.total} pts. <button class="ghost danger" onclick="clearImports()">Delete them all</button></p>` : ''}
          <div class="err">${esc(S.err.import || '')}</div>
          ${S.importMsg ? `<p class="small" style="color:var(--accent)">${esc(S.importMsg)}</p>` : ''}
        </div>
        <div class="mt">
          <label>Or wrap this round and start a fresh topic</label>
          <input type="text" id="newtopic" placeholder="New topic (e.g. 90s Movies)" value="${esc(val('newtopic'))}">
          <div class="row mt">
            <select id="newhostSel" class="grow">${g.players.map(p => `<option value="${p.id}" ${p.id === g.me.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
            <button class="danger" onclick="newRound()">New round</button>
          </div>
          <p class="small muted mt">Archives “${esc(g.round.topic)}” — its history and stats stick around.</p>
        </div>
        <div class="err">${esc(S.err.round || '')}</div>
      </div>
    </details>
  </div>`;
}

// ---------- actions ----------

async function act(fn, errKey) {
  try { S.err[errKey || 'game'] = ''; await fn(); }
  catch (e) { S.err[errKey || 'game'] = e.message; }
  refresh();
}

function submitGuess() {
  const g = document.getElementById('guess').value.trim();
  if (!g) return;
  act(async () => { await api('/api/guess', { guess: g }); clearVal('guess'); });
}
function passGuess() { act(async () => { await api('/api/guess', { guess: '' }); clearVal('guess'); }); }
function recallQ(id) {
  if (!confirm('Pull this question back into the queue for editing? Any guesses submitted so far are discarded.')) return;
  act(async () => {
    await api(`/api/host/question/${id}/recall`, {});
    S.game = await api('/api/state');
    editDraft(id);
  }, 'host');
}
function removeQ(id) {
  if (!confirm("Remove this question? It stops counting for everyone (soft delete — the data stays in the database).")) return;
  act(async () => {
    await api(`/api/host/question/${id}/remove`, {});
    if (S.sessionDetail) S.sessionDetail = await api(`/api/session/${S.sessionDetail.id}`);
  }, 'host');
}
function deletePlayer(id) {
  const p = S.game.players.find(x => x.id === id);
  if (!confirm(`Delete ${p ? p.name : 'this player'}? They disappear from the game and stats. Soft delete — restoring brings everything back.`)) return;
  act(() => api(`/api/host/player/${id}/delete`, {}), 'round');
}
function restorePlayer(id) { act(() => api(`/api/host/player/${id}/restore`, {}), 'round'); }

async function importPoints() {
  S.err.import = ''; S.importMsg = '';
  const text = document.getElementById('importText').value;
  const createMissing = document.getElementById('importCreate').checked;
  try {
    const r = await api('/api/host/import', { text, createMissing });
    S.importMsg = `Imported ${r.imported} entr${r.imported === 1 ? 'y' : 'ies'}${r.created.length ? ` and created ${r.created.join(', ')}` : ''}.`;
    clearVal('importText');
  } catch (e) { S.err.import = e.message; }
  refresh();
}
function clearImports() {
  if (!confirm('Delete ALL imported points in this round? (The real game results are untouched.)')) return;
  S.importMsg = '';
  act(() => api('/api/host/import/clear', {}), 'import');
}
function submitChoice(i) { act(() => api('/api/choice', { choice: i })); }
function advance(id) { act(() => api(`/api/host/question/${id}/advance`, {}), 'host'); }
function judge(qid, pid, correct) { act(() => api('/api/host/judge', { questionId: qid, playerId: pid, correct }), 'host'); }
function startQ(id) { act(() => api(`/api/host/question/${id}/start`, {}), 'host'); }
function deleteQ(id) { if (confirm('Delete this question?')) act(() => api(`/api/host/question/${id}/delete`, {}), 'host'); }
function endSession() { if (confirm('End today\'s game?')) act(() => api('/api/host/session/end', {}), 'host'); }

function transferHost() {
  const pid = Number(document.getElementById('transferSel').value);
  const p = S.game.players.find(x => x.id === pid);
  if (!confirm(`Make ${p?.name} the host of ${S.game.round.topic}?`)) return;
  act(() => api('/api/host/transfer', { playerId: pid }), 'round');
}

function createRound(inputId) {
  const topic = document.getElementById(inputId).value.trim();
  act(async () => { await api('/api/host/round', { topic }); clearVal(inputId); }, 'round');
}

function newRound() {
  const topic = document.getElementById('newtopic').value.trim();
  const hostId = Number(document.getElementById('newhostSel').value);
  if (!topic) { S.err.round = 'Give the new round a topic'; render(); return; }
  const host = S.game.players.find(p => p.id === hostId);
  if (!confirm(`Wrap up "${S.game.round.topic}" and start "${topic}" with ${host?.name} hosting?`)) return;
  act(async () => { await api('/api/host/round', { topic, hostId }); clearVal('newtopic'); }, 'round');
}

function saveQuestion() {
  const dateEl = document.getElementById('qdate');
  const body = {
    text: document.getElementById('qtext').value.trim(),
    answer: document.getElementById('qanswer').value.trim(),
    decoys: [0, 1, 2, 3].map(i => document.getElementById('decoy' + i).value.trim()).filter(Boolean),
    date: dateEl ? dateEl.value.trim() : '',
  };
  const path = S.editingDraft ? `/api/host/question/${S.editingDraft}/update` : '/api/host/question';
  act(async () => {
    S.hostMsg = '';
    const r = await api(path, body);
    S.editingDraft = null;
    clearVal('qtext', 'qanswer', 'decoy0', 'decoy1', 'decoy2', 'decoy3', 'qdate');
    if (r.backdated) S.hostMsg = `Added to ${r.backdated} in History.`;
  }, 'host');
}

function editDraft(id) {
  const d = S.game.drafts.find(x => x.id === id);
  if (!d) return;
  S.editingDraft = id;
  draftValues.qtext = d.text;
  draftValues.qanswer = d.answer;
  const decoys = d.choices.filter((_, i) => i !== d.correctIndex);
  [0, 1, 2, 3].forEach(i => { draftValues['decoy' + i] = decoys[i] || ''; });
  render();
}
function cancelEdit() {
  S.editingDraft = null;
  clearVal('qtext', 'qanswer', 'decoy0', 'decoy1', 'decoy2', 'decoy3');
  render();
}

// ---------- history ----------

async function loadHistory() {
  S.history = await api('/api/history');
  render();
}

async function openSession(id) {
  S.sessionDetail = await api(`/api/session/${id}`);
  S.makeup = null;
  render();
}

function renderHistory() {
  if (S.makeup) return renderMakeup();
  if (S.sessionDetail) return renderSessionDetail();
  if (!S.history) return '<div class="empty">Loading…</div>';
  if (!S.history.rounds.length) return '<div class="empty">No games played yet.</div>';
  return S.history.rounds.map(r => `<div class="round-block">
    <div class="round-head">
      <h2>${esc(r.topic)}</h2>
      <span class="muted small">hosted by ${esc(r.hostName)}${r.status === 'archived' ? ' · archived' : ''}</span>
    </div>
    ${r.sessions.length ? r.sessions.map(s => `<div class="card day-card">
      <div class="row" style="margin-bottom:6px">
        <b>${esc(s.date)}</b>
        <span class="muted small">${s.questionCount} question${s.questionCount === 1 ? '' : 's'}${s.status === 'open' ? ' · live' : ''}</span>
        <span class="grow"></span>
        <button class="ghost" onclick="openSession(${s.id})">Full detail</button>
      </div>
      ${s.questions.length ? `<ol class="qlist">
        ${s.questions.map(qq => qq.locked
          ? `<li class="muted">Hidden until you play it
              ${qq.canMakeup ? `<button class="ghost" onclick="S.makeupReturn='history';startMakeup(${qq.id})">Play it</button>` : ''}</li>`
          : `<li>${esc(qq.text)}</li>`).join('')}
      </ol>` : ''}
      ${s.points.length ? `<div class="waiting-list">
        ${s.points.map(p => `<span class="chip">${avatar(p.name, p.emoji)} ${esc(p.name)} <b class="daypts">+${p.points}</b>${'<img src="/parrot.gif" class="parrot" alt="party parrot">'.repeat(Math.min(p.points, 4))}</span>`).join('')}
      </div>` : '<p class="muted small">No points recorded this day.</p>'}
      ${s.pending.length ? `<p class="small muted mt">Needs makeup: ${s.pending.map(n => esc(n)).join(', ')}</p>` : ''}
    </div>`).join('') : '<p class="muted small">No games in this round yet.</p>'}
  </div>`).join('');
}

function renderSessionDetail() {
  const d = S.sessionDetail;
  return `<div>
    <div class="row" style="margin-bottom:16px">
      <button onclick="S.sessionDetail=null;render()">← All days</button>
      <h2>${esc(d.topic)} — ${esc(d.date)}</h2>
    </div>
    ${d.questions.length ? d.questions.map(qq => qq.locked ? `
      <div class="locked-q">
        <b>Question ${qq.index}</b> — hidden because you haven't played it yet
        <div class="row mt" style="justify-content:center">
          ${qq.canMakeup ? `<button class="primary" onclick="S.makeupReturn='history';startMakeup(${qq.id})">Play it now</button>` : '<span class="muted small">still in play</span>'}
        </div>
      </div>` : `
      <div class="card q-detail">
        <div class="qnum">Question ${qq.index}</div>
        <div class="question-text" style="font-size:1.15rem">${esc(qq.text)}</div>
        <div class="answer-banner" style="font-size:1rem">Answer: <b>${esc(qq.answer)}</b></div>
        ${resultsTable(qq, qq.canJudge)}
        ${qq.canJudge ? `<div class="mt"><button class="danger" onclick="removeQ(${qq.id})">Remove question (stops counting)</button></div>` : ''}
      </div>`).join('') : '<div class="empty">No questions were asked this day.</div>'}
  </div>`;
}


// ---------- makeup ----------

async function startMakeup(qid) {
  S.makeup = { id: qid, data: await api(`/api/makeup/${qid}`) };
  render();
}

function renderMakeup() {
  const m = S.makeup.data;
  const backLabel = S.makeupReturn === 'game' ? 'the game' : (S.sessionDetail?.date || 'history');
  const back = `<div class="row" style="margin-bottom:16px"><button onclick="exitMakeup()">← Back to ${esc(backLabel)}</button></div>`;

  if (m.stage === 'guess') {
    return `${back}<div class="card">
      <span class="phase-tag guessing">Makeup — write your guess first</span>
      <div class="question-text">${esc(m.text)}</div>
      <div class="row">
        <input type="text" id="mguess" class="grow" placeholder="No peeking — guess like everyone else did" value="${esc(val('mguess'))}"
          onkeydown="if(event.key==='Enter')makeupGuess()">
        <button class="primary" onclick="makeupGuess()">Lock it in</button>
        <button onclick="makeupGuess(true)" title="Skip the written guess — you can still answer the multiple choice for 1 point">Pass</button>
      </div>
      <div class="err">${esc(S.err.makeup || '')}</div>
    </div>`;
  }
  if (m.stage === 'choose') {
    return `${back}<div class="card">
      <span class="phase-tag reveal">Here's what everyone guessed</span>
      <div class="question-text">${esc(m.text)}</div>
      <div class="guess-grid" style="margin-bottom:18px">
        <div class="guess-card" style="border-color:var(--sky)"><div class="who">You</div><div class="what">${m.myGuess === '' ? '<span class="muted">(passed)</span>' : esc(m.myGuess)}</div></div>
        ${m.others.map(o => `<div class="guess-card"><div class="who">${avatar(o.name, o.emoji)} ${esc(o.name)}</div><div class="what">${o.guess === '' ? '<span class="muted">(passed)</span>' : esc(o.guess)}</div></div>`).join('')}
      </div>
      <span class="phase-tag choosing">Now pick — stick with your guess for 2</span>
      <div class="choices">
        ${m.choices.map((c, i) => `<button onclick="makeupChoice(${i})"><span class="letter">${'ABCD'[i] || i + 1}</span> ${esc(c)}</button>`).join('')}
      </div>
      <div class="err">${esc(S.err.makeup || '')}</div>
    </div>`;
  }
  // done
  const qq = m.detail;
  return `${back}<div class="card">
    <span class="phase-tag results">Results</span>
    <div class="question-text">${esc(qq.text)}</div>
    <div class="answer-banner">Answer: <b>${esc(qq.answer)}</b></div>
    ${resultsTable(qq, false)}
    <p class="small muted mt">Your written guess was auto-judged — the host can fix it if it was robbed.</p>
  </div>`;
}

async function exitMakeup() {
  S.makeup = null;
  if (S.makeupReturn === 'game') {
    S.makeupReturn = null;
    S.view = 'game';
    await refresh();
    return;
  }
  if (S.sessionDetail) S.sessionDetail = await api(`/api/session/${S.sessionDetail.id}`);
  else if (!S.history) { await loadHistory(); return; }
  render();
}

function makeupGuess(pass) {
  const g = pass ? '' : document.getElementById('mguess').value.trim();
  if (!pass && !g) return;
  act(async () => {
    await api(`/api/makeup/${S.makeup.id}/guess`, { guess: g });
    clearVal('mguess');
    S.makeup.data = await api(`/api/makeup/${S.makeup.id}`);
  }, 'makeup');
}

function makeupChoice(i) {
  act(async () => {
    const r = await api(`/api/makeup/${S.makeup.id}/choice`, { choice: i });
    S.makeup.data = { stage: 'done', detail: r.detail };
    const mine = r.detail.answers.find(a => a.playerId === S.me.id);
    if (mine && mine.points > 0) {
      confettiBurst(mine.points);
      if (mine.points === 2) setTimeout(() => confettiBurst(2), 450);
    }
  }, 'makeup');
}

// ---------- stats ----------

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function statsRange() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  if (S.statsPeriod === 'this') return { from: fmtDate(new Date(y, m, 1)), to: fmtDate(new Date(y, m + 1, 0)) };
  if (S.statsPeriod === 'last') return { from: fmtDate(new Date(y, m - 1, 1)), to: fmtDate(new Date(y, m, 0)) };
  if (S.statsPeriod === 'custom') return { from: S.statsFrom || '', to: S.statsTo || '' };
  return {};
}

async function loadStats() {
  const r = statsRange();
  let qs = `roundId=${S.statsRound}`;
  if (r.from) qs += `&from=${r.from}`;
  if (r.to) qs += `&to=${r.to}`;
  S.stats = await api(`/api/stats?${qs}`);
  render();
}

function setStatsRound(v) { S.statsRound = v; loadStats(); }
function setStatsPeriod(v) {
  S.statsPeriod = v;
  if (v === 'custom') render();
  else loadStats();
}
function applyStatsRange() {
  S.statsFrom = document.getElementById('statsFrom').value;
  S.statsTo = document.getElementById('statsTo').value;
  loadStats();
}

function renderStats() {
  if (!S.stats) return '<div class="empty">Loading…</div>';
  const st = S.stats;
  const pct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '—';
  return `<div class="card">
    <div class="row" style="margin-bottom:14px">
      <h2 class="grow">Leaderboard</h2>
      <select style="width:auto" onchange="setStatsRound(this.value)">
        <option value="all" ${S.statsRound === 'all' ? 'selected' : ''}>All rounds</option>
        ${st.rounds.map(r => `<option value="${r.id}" ${S.statsRound == r.id ? 'selected' : ''}>${esc(r.topic)}${r.status === 'active' ? ' (current)' : ''}</option>`).join('')}
      </select>
      <select style="width:auto" onchange="setStatsPeriod(this.value)">
        <option value="all" ${(S.statsPeriod || 'all') === 'all' ? 'selected' : ''}>All time</option>
        <option value="this" ${S.statsPeriod === 'this' ? 'selected' : ''}>This month</option>
        <option value="last" ${S.statsPeriod === 'last' ? 'selected' : ''}>Last month</option>
        <option value="custom" ${S.statsPeriod === 'custom' ? 'selected' : ''}>Custom range</option>
      </select>
    </div>
    ${S.statsPeriod === 'custom' ? `<div class="row" style="margin-bottom:14px">
      <input type="date" id="statsFrom" style="width:auto" value="${esc(S.statsFrom || '')}">
      <span class="muted small">to</span>
      <input type="date" id="statsTo" style="width:auto" value="${esc(S.statsTo || '')}">
      <button onclick="applyStatsRange()">Apply</button>
    </div>` : ''}
    ${(S.statsPeriod && S.statsPeriod !== 'all') ? (() => {
      const r = statsRange();
      return `<p class="small muted" style="margin-bottom:10px">Showing ${esc(r.from || 'the beginning')} through ${esc(r.to || 'today')}.</p>`;
    })() : ''}
    ${st.rows.length ? (() => {
      const anyImported = st.rows.some(r => r.imported > 0);
      return `<div style="overflow-x:auto"><table class="stats">
      <tr><th>Player</th><th>Points</th>${anyImported ? '<th>Imported</th>' : ''}<th>Played</th><th>Guess acc.</th><th>MC acc.</th><th>2-pointers</th><th>Makeups</th><th>Owed</th></tr>
      ${st.rows.map((r, i) => `<tr>
        <td>${avatar(r.name, r.emoji)} ${esc(r.name)}</td>
        <td><b>${r.points}</b></td>
        ${anyImported ? `<td>${r.imported || 0}</td>` : ''}
        <td>${r.played}</td>
        <td>${pct(r.guessRight, r.guesses)}</td>
        <td>${pct(r.mcRight, r.answered)}</td>
        <td>${r.twoPointers}</td>
        <td>${r.makeups}</td>
        <td>${r.owed ? `<b style="color:var(--bad)">${r.owed}</b>` : '0'}</td>
      </tr>`).join('')}
    </table></div>`;
    })() : `<p class="empty">${(S.statsPeriod && S.statsPeriod !== 'all') ? 'No points in this period.' : 'No finished questions yet — stats appear after your first game.'}</p>`}
    <p class="small muted mt">Guess acc. = written guesses judged correct. 2-pointers = guessed it and stuck with it.
      Played includes pre-app days covered by imports; accuracy only counts in-app answers. Owed = makeups outstanding.</p>
  </div>`;
}

// ---------- boot ----------

Object.assign(window, {
  logout, setView, doVerify, doLogin, doCreate, submitGuess, submitChoice, advance, judge,
  startQ, deleteQ, endSession, transferHost, createRound, newRound, saveQuestion, editDraft,
  cancelEdit, openSession, startMakeup, exitMakeup, makeupGuess, makeupChoice,
  setStatsRound, setStatsPeriod, applyStatsRange, passGuess, removeQ, recallQ, deletePlayer,
  restorePlayer, playMakeup, setMyBird, importPoints, clearImports, tvLogin, deputyStart, deputyAdv,
  S, render,
});

const birdToggleBtn = document.getElementById('bird-toggle');
if (birdToggleBtn) { birdToggleBtn.onclick = toggleBirds; syncBirdToggleBtn(); }

if (S.token) { connectSSE(); refresh(); }
render();

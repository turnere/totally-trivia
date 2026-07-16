/* Totally Trivia — frontend. Vanilla JS, no build step. */

const $app = document.getElementById('app');

const S = {
  token: localStorage.getItem('tt_token') || null,
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

const AV_COLORS = ['#2f7d5d', '#3c6fb8', '#c9931a', '#b3593d', '#6b5aa8', '#2b7d84', '#a84f6f', '#5a7d2f'];
function avatar(name) {
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
  localStorage.removeItem('tt_token');
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
    if (S.view === 'history' && S.sessionDetail && !S.makeup) {
      S.sessionDetail = await api(`/api/session/${S.sessionDetail.id}`);
    }
    if (S.view === 'stats') S.stats = await api(`/api/stats?roundId=${S.statsRound}`);
    render();
  } catch (e) { /* transient */ }
}
window.addEventListener('focus', refresh);

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

function render() {
  const focused = document.activeElement;
  const focusedId = focused && focused.id && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA') ? focused.id : null;
  const selStart = focusedId ? focused.selectionStart : 0;

  if (!S.token) { $app.innerHTML = renderLogin(); restoreFocus(focusedId, selStart); return; }
  if (!S.game) { $app.innerHTML = '<div class="empty">Loading…</div>'; return; }

  const g = S.game;
  $app.innerHTML = `
    <header>
      <div class="logo">Totally <span>Trivia</span></div>
      ${g.round ? `<div class="topic">${esc(g.round.topic)}</div>` : ''}
      <div class="spacer"></div>
      <div class="whoami">${avatar(g.me.name)} ${esc(g.me.name)}${g.isHost ? ' · <b>host</b>' : ''}
        <button class="ghost" onclick="logout()">log out</button>
      </div>
    </header>
    <nav class="tabs">
      ${['game', 'history', 'stats'].map(v =>
        `<button class="${S.view === v ? 'active' : ''}" onclick="setView('${v}')">${{ game: 'Play', history: 'History', stats: 'Stats' }[v]}</button>`).join('')}
    </nav>
    ${S.view === 'game' ? renderGame() : S.view === 'history' ? renderHistory() : renderStats()}
  `;
  restoreFocus(focusedId, selStart);
}

function setView(v) {
  S.view = v;
  if (v === 'history') { S.sessionDetail = null; S.makeup = null; loadHistory(); }
  if (v === 'stats') loadStats();
  render();
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
        ${S.loginPlayers.map(p => `<button onclick="doLogin(${p.id})">${avatar(p.name)}${esc(p.name)}</button>`).join('')}
      </div><hr style="border:none;border-top:1px dashed var(--line);margin:14px 0">` : ''}
      <h3>New player</h3>
      <input type="text" id="newname" placeholder="Your name" value="${esc(val('newname'))}" onkeydown="if(event.key==='Enter')doCreate()">
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
    await finishLogin(await api('/api/login', { password: S.loginPassword, name }));
  } catch (e) { S.err.login = e.message; render(); }
}

// ---------- game view ----------

function renderGame() {
  const g = S.game;
  if (!g.round) return renderNoRound();

  const main = g.question ? renderQuestion() : renderBetweenQuestions();
  return `<div class="game-layout">
    <div>${main}${g.isHost ? renderHostTools() : ''}</div>
    <div>${renderScoreboard()}</div>
  </div>`;
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
      ${rows.map((r, i) => `<li><span class="pos">${i + 1}</span>${avatar(r.name)} ${esc(r.name)}
        <span class="pts ${r.points >= 2 ? 'two' : r.points ? 'one' : 'zero'}">${r.points}</span></li>`).join('')}
    </ul>` : '<p class="muted small">No points yet today.</p>'}
    <p class="small muted mt">Host: ${esc(g.round.hostName)}</p>
  </div>`;
}

function renderBetweenQuestions() {
  const g = S.game;
  if (g.isHost) return ''; // host sees their tools below
  return `<div class="card empty">
    Waiting for ${esc(g.round.hostName)} to launch the next question…
    ${typeof g.drafts?.count === 'number' && g.drafts.count > 0 ? `<p class="small mt">${g.drafts.count} question${g.drafts.count > 1 ? 's' : ''} in the queue</p>` : ''}
  </div>`;
}

function renderQuestion() {
  const qq = S.game.question;
  const fn = { guessing: renderGuessing, reveal: renderReveal, choosing: renderChoosing, results: renderResults }[qq.phase];
  return fn ? fn(qq) : '';
}

function playerChips(qq, doneFn, verb) {
  return `<div class="waiting-list">
    ${S.game.players.filter(p => p.id !== S.game.round.hostId).map(p => {
      const a = qq.answers.find(x => x.playerId === p.id);
      const done = a && doneFn(a);
      return `<span class="chip ${done ? 'done' : ''}">${avatar(p.name)} ${esc(p.name)} ${done ? '<span class="tick">✓</span>' : ''}</span>`;
    }).join('')}
  </div>
  <p class="small muted mt">${qq.answers.filter(doneFn).length} ${verb}</p>`;
}

function renderGuessing(qq) {
  const mine = qq.myAnswer?.guess;
  return `<div class="card">
    <span class="phase-tag guessing">Write your guess</span>
    <div class="question-text">${esc(qq.text)}</div>
    ${S.game.isHost ? '<p class="small muted">Read it out — you judge, you don\'t play.</p>' : `<div class="row">
      <input type="text" id="guess" class="grow" placeholder="Your guess — nobody sees it until the reveal"
        value="${esc(val('guess') || mine || '')}" onkeydown="if(event.key==='Enter')submitGuess()">
      <button class="primary" onclick="submitGuess()">${mine ? 'Update' : 'Lock it in'}</button>
    </div>
    ${mine ? `<p class="small muted mt">Your guess is in: <b>${esc(mine)}</b> — you can change it until the reveal.</p>` : ''}
    <div class="err">${esc(S.err.game || '')}</div>`}
    ${playerChips(qq, a => a.hasGuess, 'guesses in')}
    ${hostAdvance(qq, 'guessing', 'Reveal all guesses')}
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
          <div class="who">${avatar(a.name)} ${esc(a.name)}</div>
          <div class="what">${esc(a.guess)}</div>
          ${isHost ? `<div class="judge-btns">
            <button class="${a.guessCorrect ? 'on-right' : ''}" title="Mark correct" onclick="judge(${qq.id},${a.playerId},true)">✓</button>
            <button class="${a.guessCorrect === false ? 'on-wrong' : ''}" title="Mark wrong" onclick="judge(${qq.id},${a.playerId},false)">✗</button>
          </div>` : ''}
        </div>`).join('')}
    </div>` : '<p class="muted">Nobody guessed! Tough crowd.</p>'}
    ${isHost ? `<p class="small muted mt">Green = counts as a correct guess (auto-judged — fix any I got wrong). Answer: <b>${esc(qq.answer)}</b></p>` : ''}
    ${hostAdvance(qq, 'reveal', 'Open multiple choice')}
  </div>`;
}

function renderChoosing(qq) {
  const mine = qq.myAnswer?.choiceIndex;
  const myGuess = qq.myAnswer?.guess;
  return `<div class="card">
    <span class="phase-tag choosing">Multiple choice — stick with your guess for 2</span>
    <div class="question-text">${esc(qq.text)}</div>
    ${myGuess ? `<p class="small muted" style="margin-bottom:10px">You guessed: <b>${esc(myGuess)}</b></p>` : ''}
    <div class="choices">
      ${qq.choices.map((c, i) => `
        <button class="${mine === i ? 'mine' : ''} ${S.game.isHost ? 'static' : ''} ${S.game.isHost && qq.correctIndex === i ? 'host-correct' : ''}" ${S.game.isHost ? '' : `onclick="submitChoice(${i})"`}>
          <span class="letter">${'ABCD'[i] || i + 1}</span> ${esc(c)}
        </button>`).join('')}
    </div>
    <div class="err">${esc(S.err.game || '')}</div>
    ${playerChips(qq, a => a.hasChoice, 'locked in')}
    ${hostAdvance(qq, 'choosing', 'Show results')}
  </div>`;
}

function resultRow(a, qq, canJudge) {
  const choiceTxt = a.forfeited ? '<span class="muted">skipped</span>'
    : a.choiceIndex === null || a.choiceIndex === undefined ? '<span class="muted">—</span>'
    : `${esc(qq.choices[a.choiceIndex])} ${a.choiceIndex === qq.correctIndex ? '<span class="mark-right">✓</span>' : '<span class="mark-wrong">✗</span>'}`;
  const guessTxt = a.guess === null || a.guess === undefined ? '<span class="muted">—</span>'
    : `${esc(a.guess)} ${a.guessCorrect ? '<span class="mark-right">✓</span>' : '<span class="mark-wrong">✗</span>'}`;
  return `<tr>
    <td>${avatar(a.name)} ${esc(a.name)} ${a.isMakeup ? '<span class="badge makeup">makeup</span>' : ''}</td>
    <td>${guessTxt}
      ${canJudge && a.guess != null ? `<button class="ghost small" onclick="judge(${qq.id},${a.playerId},${!a.guessCorrect})">flip</button>` : ''}</td>
    <td>${choiceTxt}</td>
    <td><span class="pts ${a.points === 2 ? 'two' : a.points === 1 ? 'one' : 'zero'}">+${a.points ?? 0}</span>
      ${a.points === 2 ? '<span class="badge">stuck the landing</span>' : ''}</td>
  </tr>`;
}

function renderResults(qq) {
  return `<div class="card">
    <span class="phase-tag results">Results</span>
    <div class="question-text">${esc(qq.text)}</div>
    <div class="answer-banner">Answer: <b>${esc(qq.answer)}</b></div>
    <table class="results">
      <tr><th>Player</th><th>Written guess</th><th>Multiple choice</th><th>Points</th></tr>
      ${qq.answers.map(a => resultRow(a, qq, S.game.isHost)).join('')}
    </table>
    ${S.game.isHost ? `<p class="small muted mt">Wrong call on a guess? Hit “flip” — points recalculate.</p>` : ''}
  </div>`;
}

function hostAdvance(qq, phase, label) {
  if (!S.game.isHost) return '';
  return `<div class="mt"><button class="primary big" onclick="advance(${qq.id})">${label}</button></div>`;
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
        <div class="q">${esc(d.text)}<div class="a">→ ${esc(d.answer)}</div></div>
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
        <div class="err">${esc(S.err.host || '')}</div>
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
  const body = {
    text: document.getElementById('qtext').value.trim(),
    answer: document.getElementById('qanswer').value.trim(),
    decoys: [0, 1, 2, 3].map(i => document.getElementById('decoy' + i).value.trim()).filter(Boolean),
  };
  const path = S.editingDraft ? `/api/host/question/${S.editingDraft}/update` : '/api/host/question';
  act(async () => {
    await api(path, body);
    S.editingDraft = null;
    clearVal('qtext', 'qanswer', 'decoy0', 'decoy1', 'decoy2', 'decoy3');
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
    ${r.sessions.length ? `<div class="session-list">
      ${r.sessions.map(s => `<button onclick="openSession(${s.id})">${esc(s.date)}${s.status === 'open' ? ' · live' : ''}
        <div class="cnt">${s.questionCount} question${s.questionCount === 1 ? '' : 's'}</div></button>`).join('')}
    </div>` : '<p class="muted small">No games in this round yet.</p>'}
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
          ${qq.canMakeup ? `<button class="primary" onclick="startMakeup(${qq.id})">Play it now</button>
          <button onclick="forfeitQ(${qq.id})">Just show me (0 pts)</button>` : '<span class="muted small">still in play</span>'}
        </div>
      </div>` : `
      <div class="card q-detail">
        <div class="qnum">Question ${qq.index}</div>
        <div class="question-text" style="font-size:1.15rem">${esc(qq.text)}</div>
        <div class="answer-banner" style="font-size:1rem">Answer: <b>${esc(qq.answer)}</b></div>
        <table class="results">
          <tr><th>Player</th><th>Written guess</th><th>Multiple choice</th><th>Points</th></tr>
          ${qq.answers.map(a => resultRow(a, qq, qq.canJudge)).join('')}
        </table>
      </div>`).join('') : '<div class="empty">No questions were asked this day.</div>'}
  </div>`;
}

function forfeitQ(id) {
  if (!confirm('Reveal this question without playing? You get 0 points and it counts as viewed.')) return;
  act(async () => {
    await api(`/api/makeup/${id}/forfeit`, {});
    S.sessionDetail = await api(`/api/session/${S.sessionDetail.id}`);
    render();
  });
}

// ---------- makeup ----------

async function startMakeup(qid) {
  S.makeup = { id: qid, data: await api(`/api/makeup/${qid}`) };
  render();
}

function renderMakeup() {
  const m = S.makeup.data;
  const back = `<div class="row" style="margin-bottom:16px"><button onclick="exitMakeup()">← Back to ${esc(S.sessionDetail?.date || 'history')}</button></div>`;

  if (m.stage === 'guess') {
    return `${back}<div class="card">
      <span class="phase-tag guessing">Makeup — write your guess first</span>
      <div class="question-text">${esc(m.text)}</div>
      <div class="row">
        <input type="text" id="mguess" class="grow" placeholder="No peeking — guess like everyone else did" value="${esc(val('mguess'))}"
          onkeydown="if(event.key==='Enter')makeupGuess()">
        <button class="primary" onclick="makeupGuess()">Lock it in</button>
      </div>
      <div class="err">${esc(S.err.makeup || '')}</div>
    </div>`;
  }
  if (m.stage === 'choose') {
    return `${back}<div class="card">
      <span class="phase-tag reveal">Here's what everyone guessed</span>
      <div class="question-text">${esc(m.text)}</div>
      <div class="guess-grid" style="margin-bottom:18px">
        <div class="guess-card" style="border-color:var(--sky)"><div class="who">You</div><div class="what">${esc(m.myGuess)}</div></div>
        ${m.others.map(o => `<div class="guess-card"><div class="who">${avatar(o.name)} ${esc(o.name)}</div><div class="what">${esc(o.guess)}</div></div>`).join('')}
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
    <table class="results">
      <tr><th>Player</th><th>Written guess</th><th>Multiple choice</th><th>Points</th></tr>
      ${qq.answers.map(a => resultRow(a, qq, false)).join('')}
    </table>
    <p class="small muted mt">Your written guess was auto-judged — the host can fix it if it was robbed.</p>
  </div>`;
}

async function exitMakeup() {
  S.makeup = null;
  if (S.sessionDetail) S.sessionDetail = await api(`/api/session/${S.sessionDetail.id}`);
  render();
}

function makeupGuess() {
  const g = document.getElementById('mguess').value.trim();
  if (!g) return;
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
  }, 'makeup');
}

// ---------- stats ----------

async function loadStats() {
  S.stats = await api(`/api/stats?roundId=${S.statsRound}`);
  render();
}

function setStatsRound(v) { S.statsRound = v; loadStats(); }

function renderStats() {
  if (!S.stats) return '<div class="empty">Loading…</div>';
  const st = S.stats;
  const pct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '—';
  return `<div class="card">
    <div class="row" style="margin-bottom:14px">
      <h2 class="grow">Leaderboard</h2>
      <select style="width:auto" onchange="setStatsRound(this.value)">
        <option value="all" ${S.statsRound === 'all' ? 'selected' : ''}>All time</option>
        ${st.rounds.map(r => `<option value="${r.id}" ${S.statsRound == r.id ? 'selected' : ''}>${esc(r.topic)}${r.status === 'active' ? ' (current)' : ''}</option>`).join('')}
      </select>
    </div>
    ${st.rows.length ? `<div style="overflow-x:auto"><table class="stats">
      <tr><th>Player</th><th>Points</th><th>Played</th><th>Guess acc.</th><th>MC acc.</th><th>2-pointers</th><th>Makeups</th></tr>
      ${st.rows.map((r, i) => `<tr>
        <td>${avatar(r.name)} ${esc(r.name)}</td>
        <td><b>${r.points}</b></td>
        <td>${r.played}</td>
        <td>${pct(r.guessRight, r.guesses)}</td>
        <td>${pct(r.mcRight, r.played)}</td>
        <td>${r.twoPointers}</td>
        <td>${r.makeups}</td>
      </tr>`).join('')}
    </table></div>` : '<p class="empty">No finished questions yet — stats appear after your first game.</p>'}
    <p class="small muted mt">Guess acc. = written guesses judged correct. 2-pointers = guessed it and stuck with it.</p>
  </div>`;
}

// ---------- boot ----------

Object.assign(window, {
  logout, setView, doVerify, doLogin, doCreate, submitGuess, submitChoice, advance, judge,
  startQ, deleteQ, endSession, transferHost, createRound, newRound, saveQuestion, editDraft,
  cancelEdit, openSession, startMakeup, exitMakeup, makeupGuess, makeupChoice, forfeitQ,
  setStatsRound, S, render,
});

if (S.token) { connectSSE(); refresh(); }
render();

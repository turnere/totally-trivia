# Totally Trivia

Standup trivia for the team. Guess first, then multiple choice — stick the landing for 2 points.

## Run it

```sh
node server.js
```

Requires Node 22+ (uses the built-in SQLite — zero npm dependencies). Opens on
[http://localhost:3311](http://localhost:3311).

Options (env vars):

| Var | Default | What |
|---|---|---|
| `TRIVIA_PASSWORD` | `chickadee` | The shared team password — change it! |
| `PORT` | `3311` | Port to listen on |

Everything is stored in `data/trivia.db` (SQLite). Back that file up and you've backed up all
history, answers, and stats.

For the team to reach it, run it on a machine they can hit (office server, small VPS, tailscale
node, etc.) — e.g. `TRIVIA_PASSWORD=ourpassword PORT=80 node server.js`.

## How the game works

1. **Log in** with the shared password and pick who you are (new players add themselves).
2. The **host** queues up questions in the Host desk (question + correct answer + 2-4 decoys;
   the answer gets shuffled into the choices automatically).
3. Host hits **Ask it**:
   - **Guessing** — everyone privately types a written guess. You only see who has answered.
   - **Reveal** — all guesses appear at once. Written guesses are auto-judged (typo-tolerant);
     the host can flip any call.
   - **Multiple choice** — pick one. Stick with your correct guess for 2 points.
   - **Results** — correct multiple choice = 1 pt; correct guess and correct choice = 2 pts.
4. The first question of the day automatically opens today's game; the host ends it from
   Round controls (or it rolls over automatically the next day).

## Makeup games (for folks who were out)

History, pick a day: questions you haven't played are hidden so there's no unfair advantage.
Hit **Play it now** to make it up properly: you guess blind first, then it shows you what
everyone else guessed, then you pick your multiple choice. Points count (flagged as a makeup
in results). Or hit **Just show me** to reveal it for 0 points.

## Handing off the host

Host desk, Round controls:

- **Transfer** — same topic, new host (e.g. you're out sick).
- **New round** — wraps the current topic and starts a fresh one with whoever you pick as
  host. Old rounds stay in History and Stats forever.

## Stats

Leaderboard per round or all-time: points, guess accuracy, multiple-choice accuracy,
2-pointers ("stuck the landing"), and makeup counts.

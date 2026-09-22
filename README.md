# j-play-live

Play archived *Jeopardy!* games live on [J! Archive](https://j-archive.com): the host reads
each clue aloud, you ring in against the original contestants, and you answer by voice.
Built on top of **j-play 1.4.0** by Wayne Davison (the original "review" mode is still there).

## Try it (before the Chrome Web Store listing is live)

Friends-and-family install page, with the download and the steps in plain language:
**https://jmckee1727.github.io/j-play-live/**. The zip behind the button is the newest
[release](https://github.com/jmckee1727/j-play-live/releases/latest) (`j-play-live.zip`,
the exact package built by `build.sh`).

## Install (unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (`j-play-live`).
4. If the original **j-play** extension is also installed, turn it off — both would otherwise
   run on the same pages.
5. Open any game on J! Archive (for example `https://j-archive.com/showgame.php?game_id=9537`)
   and click the **▶ Play Live** button that appears above the board.

After editing any file here, click the reload icon on the extension's card in
`chrome://extensions` and reload the J! Archive tab.

## The studio voice

The host can speak with a natural neural voice that runs entirely on your computer: Kokoro-82M
(open source, Apache 2.0), executed in the browser with ONNX Runtime on the graphics processor
(WebGPU) or the CPU (WebAssembly). It's a one-time download from Hugging Face (about 326 MB for
the GPU build, 92 MB for the CPU build), cached by the browser; after that nothing leaves the
machine. On the setup screen, under **Host voice**, click **Check my computer** and then
**Download the studio voice**. With WebGPU a clue is synthesized in well under its own length;
on the CPU the game synthesizes the round's clues ahead of time so play stays smooth. If the
studio voice is off, not downloaded, or fails, the system voice is used automatically. The
contestants get studio voices of their own (distinct from the host's, matched to a guess at
their gender from the first name; each voice is a 0.5 MB file fetched once and cached) — or
system voices, under **Contestants speak** in Settings.

Pieces: `offscreen/tts.js` runs the model in a hidden extension page; `background.js` relays
messages; `neural.js` (`JPNeural`) is the game page's client with the prefetch queue and
playback; `vendor/` holds the engine (see `vendor/NOTICE.txt` for licenses).

## The studio ear

Speech recognition can run on your computer too: OpenAI's Whisper (the English-only "base" model,
about 210 MB for the GPU build or 80 MB for the CPU build; a "small" model is offered for better
results on names), executed by ONNX Runtime in the same hidden extension page as the voice. It is
the same every time, doesn't depend on Google's speech service, and nothing you say leaves the
machine. Under **Recognition** in Settings, click **Download the studio ear**; it loads with each
game. Whichever recognizer is in use, the game only *listens* when it's your turn to speak: after
you ring in (in Final Jeopardy! too), while you pick clues by voice on your own board, and while
you wager on your Daily Double; never while someone else has the clue. The first phrase with
something in it is your response and is judged on the spot, right or wrong; a bare "What is…" or
an "um" isn't a response yet, so listening continues. The **Microphone** setting decides what
happens to the device in between: *on for the whole game* (the default) holds the stream open from
the first clue to the end, so the input never starts and stops mid-game — which is what makes
headphones hiccup — with audio outside your turns discarded at once; *on only while the game
listens* opens and releases it around each turn, so the mic light is off between turns; *off*
means you type your responses.

**Microphone** (Settings) chooses which mic the studio ear opens. *Automatic* takes the system
default, except when that's a Bluetooth headset and there's a built-in mic: then the built-in one,
because opening a headset's own microphone drops it into its low-quality call mode — which is the
"the sound changes while the game listens" effect with AirPods. With headphones on, echo
cancellation is also left off (the sound can't reach the mic, and engaging it can reconfigure the
output for a moment). **Playback** routes the game's own sounds — the studio voice, effects, music —
to a chosen output; a system voice always follows the system default. Chrome's built-in recognizer
always uses the system default microphone (System Settings → Sound → Input), so the choice above
applies to the studio ear only.

The studio ear cuts the feed into utterances with a simple energy detector, watches the feed while
it's open, and reopens the mic if the stream goes dead (a Mac with AirPods can do that). Chrome's
built-in recognizer remains available as the other option and is used automatically until the
studio ear is downloaded. **Mic log** in the same section shows what the recognizer and the
microphone did on recent clues (which device, why, and whether it was reopened), which is the
first thing to look at if answers aren't being heard.

Pieces: `offscreen/ear.js` runs Whisper (through `vendor/transformers.min.js`); `ear.js` (`JPEar`)
captures the microphone on the game page and cuts it into utterances; `JPAudio.listen` routes to it
when it is loaded.

## First run

* On the setup screen click **Test microphone** once. Besides what it heard, it reports which input
  device Chrome is using and how loud you come in; if the level is low, the fix is in **System
  Settings → Sound → Input** (pick the right microphone, raise Input volume) — the game can't turn
  the mic up itself. Chrome will ask to allow the microphone
  for `j-archive.com`; allow it. (Speech recognition in Chrome is processed by Google's speech
  service, so audio leaves your machine while the mic is listening.)
* Click **Test** next to the host voice to hear it. Any voice installed on your Mac is
  available. The default macOS voices are only the "compact" builds; the free **Enhanced** and
  **Premium** voices are a large step up and run locally with no lag: System Settings →
  Accessibility → Spoken Content → System Voice → Manage Voices…, then download **Tom**,
  **Evan** or **Nathan** (English US, Enhanced) or **Alex**. Restart Chrome; the game picks the
  best installed voice automatically.
* Start on **Easy** (contestants ring in about a second and a half after the lights; Medium is half a second, Hard 0.3 s, Champion 0.2 s — real contestants are in that range).
* **Media clues** — clues built on a picture, audio or video file. Each file is probed once when the clue comes up; what the archive has is shown with the clue (a picture stays up while the clue is read, audio plays with the reading, a video plays right after it), and what it lacks gets one note. When the media is missing, the contestants (who had it on TV) get **half credit** for their responses by default, right or wrong — or none, or full, under **Media clues** in Settings; your own responses always count in full. When the media is there, everyone scores as on TV.

## How to play

| Key | Action |
| --- | --- |
| `Space` (configurable) or a mouse click anywhere | Ring in. Before the lights = locked out for a moment. When the game is waiting for you, the same key/click moves on. With several players, each has their own key (see **Playing together**). |
| `Enter` | Lock in a typed response or a wager (also moves on). A Daily Double wager can be spoken instead ("twelve hundred", "all of it"); a Final Jeopardy! wager is typed. Clicks outside the wager box confirm nothing. |
| `Space` or a click during the Final Jeopardy! music | Ring in to respond: the music ducks, the mic opens, and your first phrase is locked in. (Typing works throughout; with the box empty, Space rings in.) |
| `y` / `n` | Overrule the judge on your last response (until the next clue). The correct response is shown after every verdict, right or wrong, so you can check the call and learn the exact wording. The money, the rebound and control of the board all follow. |
| **Rewind** (pause menu) | Every clue played so far, in order. Go back to the moment before any of them: that clue and everything after it are played again with the board, the money and control as they were; your responses from that point are cleared. |
| **Edit results** (pause menu) | Every response of yours, each with Right / No response / Wrong. Change one and the money follows: yours, and that of anyone who rang in after you on that clue (mark yourself right and the rebound never happened; mark yourself wrong and it plays out as broadcast). The ring-in order and control of the board stay as they happened. |
| a click, the buzz key or `Enter` during any line of dialogue | Skips the rest of that line (the clue reading itself excepted — a click then is a buzz). |
| `Esc` or the Pause button | Freeze everything: the buzzer race, the answer clock, the host's voice, the timer bar. Opening Settings pauses too. |
| click a clue, or say it | Pick it, when you have control of the board: "Science for 600", "Shakespeare, 400", "same category for 800" (voice picking is on when you answer by voice) |

The contestants "know" exactly what they knew in the broadcast: anyone who responded to a
clue on TV tries to ring in at a randomized reaction time set by the difficulty (log-normal: the
median is what the difficulty says, with a long right tail for clues they're unsure of), in the same
order as on TV. When a contestant has control they pick the clue that was actually picked next in the broadcast. If you beat them and answer correctly, the game diverges from the broadcast
from there (you keep control, their scores don't get that money, and so on). When a contestant
lands on a Daily Double they wager sensibly for their position and get the archived result; you
wager yourself when you land on one. In Final Jeopardy! the contestants wager the way a
game-theory-savvy player would, based on the live standings (you included), and their responses
are the archived ones. The category is shown across the top of every clue.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Extension manifest (MV3). The game runs on `j-archive.com/showgame*` pages; `played.js` on every `j-archive.com` page. |
| `played.js`, `played.css` | `JPPlayed`: the games you've finished (extension storage), the `✓` marks on the archive's lists, the note on a played game's page and the "pick up where you left off" panel. |
| `online.js` | `JPOnline`: accounts (Supabase Auth), the cloud copy of your results, lobbies, the matchmaking queue, the leaderboard, and the room channel (broadcast + presence + a clock synced to the host). The game glue itself is the "online play" section of `live.js`. |
| `vendor/supabase.js` | supabase-js (MIT), the service client. Loaded on game pages; nothing runs until you sign in. |
| `archive.js` | The original j-play code: scrapes the page into `clues[]` (indexed by broadcast order), parses responses, and provides the review mode. Small additions are marked `j-play-live`. |
| `clock.js` | `JPClock`: a pausable game clock. Every game timer runs on it, which is what makes Pause freeze the game mid-clue. |
| `audio.js` | `JPAudio`: text-to-speech (`speak`), sound effects (`play`, with `sounds/` overrides), speech recognition (`listen`). |
| `judge.js` | `JPJudge`: decides whether your response matches the archive's correct response. |
| `interpret.js` | `JPInterpret`: reads a clue like a contestant to phrase the response ("Who is" / "Who are" / "What is" / "What are"), from the noun after "this", pronouns, the category and plurality. |
| `reader.js` | `JPReader`: makes archive text speakable — abbreviations ("cont. U.S.", "pres."), Roman numerals ("Henry VIII"), decades ("the '60s"), dashes, ALL-CAPS categories, bracketed asides. |
| `wagers.js` | `JPWagers`: how the contestants wager. Final Jeopardy! uses the standard game theory (leader shores up or keeps a lock, second place beats the leader by $1 / covers / goes all in, everyone else all in); Daily Doubles use a sensible heuristic. The reasoning is shown at the reveal. |
| `names.js` | `JPNames`: first names by gender (from public-domain U.S. birth records), used to give each contestant a fitting voice. |
| `ear.js` | `JPEar`: the studio ear's client — microphone capture, utterance detection, and the same `listen()` shape as Chrome's recognizer. |
| `neural.js` | `JPNeural`: client for the studio voice — capability check, download, prefetch queue, WebAudio playback. |
| `background.js`, `offscreen/` | Service worker and the hidden page that runs the speech models (`tts.js` the voice, `ear.js` the ear). |
| `vendor/` | The bundled engines (kokoro-js, transformers.js, ONNX Runtime Web) and licenses. |
| `store/`, `PUBLISHING.md`, `build.sh` | Chrome Web Store listing text, privacy policy, publishing steps and the packaging script. |
| `live.js` | The live game: setup screen, board, buzzer race, answering, Daily Doubles, Final Jeopardy!, scoring. |
| `live.css` | Styling for the live overlay. |
| `stylecontent.css` | Original j-play styling for the review mode. |
| `sounds/` | Optional sound files (see below). |

## Playing together (offline multiplayer)

Under **Players** in Settings, choose **Two of us** or **Three of us**. Each person gets a name
and a ring-in key — click the key button and press any key (`y`, `n`, `Enter` and `Esc` are taken
by the game) — and one of you can ring in with the mouse as well. **Play against the archive's
contestants too** is on by default, so a game can have up to six podiums; switch it off and it's
just the people at the keyboard, every clue yours to fight over. You all share the one screen,
keyboard and microphone: whoever wins the buzz answers out loud (or types), a miss lets the others
ring in, whoever is right picks the next clue and plays the Daily Doubles they land on, and in Final
Jeopardy! everyone wagers in turn (the others look away), thinks through the music together, then
responds in turn. Every player gets their own saved game, and their own stats under **High scores**.

## Online play (accounts, lobbies, ranked matches)

Sign in (or create an account: a display name, an email and a password — nothing is ever sent
to the email) from the box at the top of the setup screen, and the same box offers:

* **Create a lobby** — plays this page's game with your settings (contestants on or off, speed,
  timing) for two or three of you. Friends join with the six-letter code (Join on their own setup
  screen) or the invite link; the host starts it. Only the host's y/n overrule is off online.
* **Ranked match** and **Unrated match** — a queue. When three players are waiting, the service
  picks an archive game none of you has finished and sends everyone to its page; the game starts
  when all three have arrived (a ranked match with a no-show is called off). No archive
  contestants: the three of you fight over every clue, with the same timing for everyone (6 s to
  ring in, 8 s to respond). Ranked games move your **rating** (Elo by finishing place; everyone
  starts at 1200) and your **average Coryat** in ranked play; the **Leaderboard** shows both.
* Your results — scores, Coryat, which games you've played — are kept with the account, so the
  matchmaking never repeats a game and your ✓ marks follow you to another computer. **Delete
  account** removes all of it.

How it works: every player's browser has the archive page, so the service never sees the
archive's data — only what decides the game travels between players (who rang in first, what
they said or typed, the picks, the wagers), over a private realtime channel. Everyone reads the
clue with their own voice; the lights come on for all at one moment named by the game's host
once every client is done reading, and ring-ins carry the time since that moment (clocks are
synced to the host's when you join). The host arbitrates the buzzer race — the earliest ring-in
within a short grace wins — speaks for a player who has gone quiet (a pick or a response is
forced after a timeout), and reports the finished game; the service writes results and ratings.
An online game can't be paused or rewound; leaving it lets the others go on. The correct
responses are on every player's page, so this is a game of trust among friends, with ratings and
a record to protect: statistical checks and reports are the plan for the ranked ladder.

The service is a Supabase project (Postgres, Auth, Realtime, two edge functions); the client is
the vendored `supabase-js`. Details in `PUBLISHING.md`.

## Picking up where you left off

Once you've finished a game, every J! Archive page marks it: a gold `✓` after its link in the
season lists (hover for the date and your score), and a note next to **Play Live** on the game's own
page. A small **J-Play Live** panel in the corner of every archive page offers the next game after
the last one you played — one click opens it ready to start, with your settings. (If the game you
finished was the newest in the archive, the panel takes you through it to whatever comes next once
it exists.) The list lives in the extension's own storage on this computer; the `×` hides the panel
for the rest of the browser session.

## High scores and statistics

Every finished game is recorded in this browser (your score, place, accuracy, Coryat score, Daily
Double and Final Jeopardy! results and wagers, the game) and listed under **High scores** on the
setup screen and the final screen, with your win rate, average score, average and best Coryat,
Daily Double and Final Jeopardy! success rates and average wagers, and your **streaks**: games won
in a row and days played in a row (both current and best). In a multiplayer game each player has
their own entries, chosen by name at the top of the list. The final screen also has
**Game dynamics**: everyone's final and Coryat scores with their right/wrong counts, and a chart
of every player's money after each clue (hover for the numbers), like the archive's own. The **Coryat score** is your money from the regular
clues alone: wrong responses count against you, a Daily Double counts at its face value when right
and costs nothing when wrong, and Final Jeopardy! is left out — the usual measure for playing along
at home. A result edited after the game ends (a Final Jeopardy! call overruled with `y`, or **Edit
results** on the final screen) changes the saved game too. It is all local to this computer for
now; sign-in and online play are on the list.

## The look

The clue screen and the board follow the broadcast: the clue in a Korinna-like serif (Averia Serif Libre),
white with a hard black shadow, in a narrow column of short lines sized to the screen; the board in
a compressed grotesque (Anton), white categories and gold values on the show's blue with black
gutters. Both fonts ship in `fonts/` (SIL Open Font License) and are declared at runtime from the
extension's own URLs.

## Sounds

The game ships with small synthesized tones so it works out of the box. Drop files into
`sounds/` to replace them (mp3, wav, ogg or m4a), named:

`boardfill`, `select`, `lights`, `buzz`, `lockout`, `timeout`, `right`, `wrong`, `dd`, `fj`,
`think` (the 30-second Final Jeopardy! track; without a file, an original built-in tune plays), `roundend`.

For example `sounds/timeout.mp3` or `sounds/think.wav`. Use royalty-free sounds; the show's
own cues are Sony's.

## Changing the voice later

`live.js` only ever calls `hostSay(text)` and `contestantSay(who, text)`, which sit on top of
`JPAudio.speak`. A cloud voice (OpenAI, ElevenLabs, Google) would replace `speak` with a
fetch to that API plus playback of the returned audio; nothing else needs to change.

## License and trademarks

MIT (see `LICENSE`), building on Wayne Davison's MIT-licensed j-play. Not affiliated with Jeopardy
Productions, Sony Pictures Television, or the J! Archive; *Jeopardy!* is a trademark of Jeopardy
Productions, Inc. The extension ships none of the show's music, artwork, or logos. Privacy policy:
`store/privacy-policy.md` (published at https://jmckee1727.github.io/j-play-live/store/privacy-policy.html).
Source and issues: https://github.com/jmckee1727/j-play-live.

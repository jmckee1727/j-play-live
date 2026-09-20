# j-play-live

Play archived *Jeopardy!* games live on [J! Archive](https://j-archive.com): the host reads
each clue aloud, you ring in against the original contestants, and you answer by voice.
Built on top of **j-play 1.4.0** by Wayne Davison (the original "review" mode is still there).

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

## First run

* On the setup screen click **Test microphone** once. Chrome will ask to allow the microphone
  for `j-archive.com`; allow it. (Speech recognition in Chrome is processed by Google's speech
  service, so audio leaves your machine while the mic is listening.)
* Click **Test** next to the host voice to hear it. Any voice installed on your Mac is
  available. The default macOS voices are only the "compact" builds; the free **Enhanced** and
  **Premium** voices are a large step up and run locally with no lag: System Settings →
  Accessibility → Spoken Content → System Voice → Manage Voices…, then download **Tom**,
  **Evan** or **Nathan** (English US, Enhanced) or **Alex**. Restart Chrome; the game picks the
  best installed voice automatically.
* Start on **Easy** (contestants ring in about a second after the lights; Medium is half a second, Hard 0.3 s, Champion 0.2 s — real contestants are in that range).

## How to play

| Key | Action |
| --- | --- |
| `Space` (configurable) or a mouse click anywhere | Ring in. Before the lights = locked out for a moment. When the game is waiting for you, the same key/click moves on. |
| `Enter` | Lock in a typed response or a wager (also moves on) |
| `y` / `n` | Overrule the judge on your last response (until the next clue) |
| **Rewind** (pause menu) | Every clue played so far, in order. Go back to the moment before any of them: that clue and everything after it are played again with the board, the money and control as they were; your responses from that point are cleared. |
| **Edit results** (pause menu) | Every response of yours, each with Right / No response / Wrong. Change one and the money follows: yours, and that of anyone who rang in after you on that clue (mark yourself right and the rebound never happened; mark yourself wrong and it plays out as broadcast). The ring-in order and control of the board stay as they happened. |
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
| `manifest.json` | Extension manifest (MV3). Runs on `j-archive.com/showgame*` pages. |
| `archive.js` | The original j-play code: scrapes the page into `clues[]` (indexed by broadcast order), parses responses, and provides the review mode. Small additions are marked `j-play-live`. |
| `clock.js` | `JPClock`: a pausable game clock. Every game timer runs on it, which is what makes Pause freeze the game mid-clue. |
| `audio.js` | `JPAudio`: text-to-speech (`speak`), sound effects (`play`, with `sounds/` overrides), speech recognition (`listen`). |
| `judge.js` | `JPJudge`: decides whether your response matches the archive's correct response. |
| `interpret.js` | `JPInterpret`: reads a clue like a contestant to phrase the response ("Who is" / "Who are" / "What is" / "What are"), from the noun after "this", pronouns, the category and plurality. |
| `reader.js` | `JPReader`: makes archive text speakable — abbreviations ("cont. U.S.", "pres."), Roman numerals ("Henry VIII"), decades ("the '60s"), dashes, ALL-CAPS categories, bracketed asides. |
| `wagers.js` | `JPWagers`: how the contestants wager. Final Jeopardy! uses the standard game theory (leader shores up or keeps a lock, second place beats the leader by $1 / covers / goes all in, everyone else all in); Daily Doubles use a sensible heuristic. The reasoning is shown at the reveal. |
| `names.js` | `JPNames`: first names by gender (from public-domain U.S. birth records), used to give each contestant a fitting voice. |
| `neural.js` | `JPNeural`: client for the studio voice — capability check, download, prefetch queue, WebAudio playback. |
| `background.js`, `offscreen/` | Service worker and the hidden page that runs the speech model. |
| `vendor/` | The bundled speech engine (kokoro-js, ONNX Runtime Web) and licenses. |
| `store/`, `PUBLISHING.md`, `build.sh` | Chrome Web Store listing text, privacy policy, publishing steps and the packaging script. |
| `live.js` | The live game: setup screen, board, buzzer race, answering, Daily Doubles, Final Jeopardy!, scoring. |
| `live.css` | Styling for the live overlay. |
| `stylecontent.css` | Original j-play styling for the review mode. |
| `sounds/` | Optional sound files (see below). |

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

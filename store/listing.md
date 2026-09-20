# Chrome Web Store listing (draft)

**Name:** J-Play Live: play along on J! Archive
**Category:** Fun
**Language:** English

## Summary (132 characters max)

Play archived Jeopardy! games live on J! Archive: clues read aloud, ring in, answer by voice, race the original contestants.

## Description

Turn any game on the J! Archive fan site into a live game you can play.

Open a game page on j-archive.com, click ▶ Play Live, and the host reads each clue aloud. When the reading ends the lights come on and the buzzers arm: press Space (or click) to ring in, then say your response out loud or type it. You're racing the three original contestants, who ring in exactly when and how they did on the broadcast — the archive records who responded to each clue, right or wrong, in what order — with reaction times you can tune from Easy to Champion.

• A studio-quality host voice that runs entirely on your computer (a one-time download; nothing is sent anywhere), or your system's built-in voices.
• The host reads the categories at the start of each round, the way the show does.
• Daily Doubles and Final Jeopardy! with wagering, including the game-theory-savvy wagers the contestants make against the live standings.
• Responses judged leniently, like the show ("what is" optional, surnames accepted, typos and mis-hearings forgiven), with y/n to overrule.
• The clue board and clue screens styled like the show, with the category shown on every clue.
• Pause anything, anytime. Click or press Space to move on.
• Original 30-second think music for Final Jeopardy!, and built-in sound cues you can replace with your own files.
• Pick clues the way contestants do: "Science for 600" (clicking works too).
• The contestants speak their responses in voices of their own, and the host runs the game like a host: the standings at the top of Double Jeopardy!, the Daily Double exchange, the Final Jeopardy! reveal place by place.
• Misjudged? Fix any of your responses afterwards with Edit results; only the money changes.
• When the game ends, one click takes you to the next game in the archive.

Built on the open-source j-play extension by Wayne Davison, whose "review" mode is still included.

This extension only runs on j-archive.com game pages and modifies them locally in your browser. It collects no data. Speech recognition (if you choose to answer by voice, or pick clues by voice) uses Chrome's built-in service, which processes audio through Google. The studio voice downloads the open-source Kokoro speech model from Hugging Face once and caches it locally.

Not affiliated with Jeopardy Productions, Sony Pictures Television, or the J! Archive. Jeopardy! is a trademark of Jeopardy Productions, Inc.

## Screenshots (1280×800) — in store/screenshots/

1. `1-clue.png` — the clue screen with the category strip and the lights on.
2. `2-board.png` — the board during the category read-through.
3. `3-response.png` — a response judged, podiums updated.
4. `4-setup.png` — the setup screen with the studio-voice section.
5. `5-edit-results.png` — Edit results in the pause menu.

## Privacy practices form (Developer Dashboard)

- Single purpose: lets the user play along with archived game shows on j-archive.com.
- Permission justifications:
  - `offscreen`: runs the on-device speech model in a hidden extension page.
  - Host permission `j-archive.com/showgame*`: the pages the game runs on.
  - Host permissions `huggingface.co`, `*.hf.co`: downloading the open-source speech model files, once, at the user's request.
- Remote code: none. All code ships in the package; the model download is data (weights), not code.
- Data usage: no user data is collected or transmitted.

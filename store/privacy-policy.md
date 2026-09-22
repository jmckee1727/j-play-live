# Privacy Policy — J-Play Live

*Last updated: September 22, 2026*

J-Play Live is a browser extension that lets you play along with archived game shows on the J! Archive website (j-archive.com). It runs only on j-archive.com pages: the game itself on game pages, and on the rest of the site only to mark the games you have already played.

## What the extension collects

Nothing, unless you create an account. Your settings (difficulty, voice choice, player names and keys, and similar) and your results (the scores of games you finish, and which games you have played) are saved in your browser's local storage for j-archive.com and in the extension's own storage on your computer. They are used to show you your high scores and statistics and to mark the games you have played on the archive's pages.

**If you create an account (optional, for online play)** the extension stores with the account, on the J-Play Live service (hosted on Supabase, in the United States):

- your email address and a password (the password is stored only as a hash by the authentication service; nothing is ever sent to the email address — it is only your sign-in name);
- the display name you choose, which other players and the leaderboard can see;
- your results: the score, Coryat score, finishing place and response counts of every game you finish, the archive game's id, and the id of every game you have played, so that matchmaking never gives you a game you have played and your played-game marks follow you between computers;
- for online games: the room, who played, and the ratings that follow (rating and average Coryat), which are public on the leaderboard together with your display name;
- during an online game, the messages that make the game work — when you rang in, what you typed or were heard to say, your picks and wagers — are sent to the other players in that game through the service's realtime channel and are not stored.

The extension never sends the archive's pages or their contents anywhere: each player's own browser loads the page. There is no advertising, analytics or telemetry, and nothing is sold or shared with anyone else. **Delete account** in the extension removes the account and everything stored with it at once; you can also ask through the contact below.

## Network activity

Apart from the account service above (used only when you sign in), the extension makes network requests in exactly two situations:

1. **The studio voice.** If you choose to download the studio voice, the extension downloads the open-source Kokoro speech model files from Hugging Face (huggingface.co and its content-delivery hosts) once and caches them in your browser. These requests are plain file downloads that carry no information about you. After the download, speech is generated entirely on your computer.
2. **Speech recognition.** If you choose to answer by voice, the game listens through your microphone after you ring in (and, if you keep "pick clues by voice" on, while you are choosing a clue, or while you wager on a Daily Double). By default the microphone stays open for the whole game so that the audio device does not start and stop between clues, but audio is only processed while the game is listening for you; the rest is discarded at once, and nothing is recorded or stored. You can set the microphone to open only while the game listens, or turn it off and type, in Settings. Two recognizers are offered. The **studio ear** downloads the open-source Whisper speech model from Hugging Face once (a plain file download, like the voice) and then transcribes your speech entirely on your computer; no audio leaves the machine. Until it is downloaded, or if you choose it instead, the extension uses **Chrome's built-in recognizer**, which sends microphone audio to Google's speech service while the game is listening; that is governed by Google's privacy policy, not by this extension. You can answer by typing instead, in which case no audio is captured.

Signed out, the extension contacts no server of its own. Signed in, it talks to the J-Play Live service described above, and to nothing else. There is no analytics, advertising, or telemetry.

## Permissions

- **Access to j-archive.com pages:** to add the game to game pages, and to mark the games you have played in the site's lists.
- **Storage:** to keep your results on your computer.
- **Offscreen documents:** to run the speech model in a hidden extension page.
- **huggingface.co / hf.co:** to download the speech model at your request.
- **The J-Play Live service (Supabase):** accounts and online play, only once you sign in.

## Contact

Questions about this policy: use the developer contact on the extension's Chrome Web Store listing, or open an issue at [https://github.com/jmckee1727/j-play-live/issues](https://github.com/jmckee1727/j-play-live/issues).

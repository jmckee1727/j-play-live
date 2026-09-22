# Privacy Policy — J-Play Live

*Last updated: September 21, 2026*

J-Play Live is a browser extension that lets you play along with archived game shows on the J! Archive website (j-archive.com). It runs only on j-archive.com game pages.

## What the extension collects

Nothing. The extension does not collect, store, or transmit any personal information, browsing history, or gameplay data. Your settings (difficulty, voice choice, and similar) are saved in your browser's local storage for j-archive.com and never leave your computer.

## Network activity

The extension makes network requests in exactly two situations:

1. **The studio voice.** If you choose to download the studio voice, the extension downloads the open-source Kokoro speech model files from Hugging Face (huggingface.co and its content-delivery hosts) once and caches them in your browser. These requests are plain file downloads that carry no information about you. After the download, speech is generated entirely on your computer.
2. **Speech recognition.** If you choose to answer by voice, the game listens through your microphone after you ring in (and, if you keep "pick clues by voice" on, while you are choosing a clue, or while you wager on a Daily Double). By default the microphone stays open for the whole game so that the audio device does not start and stop between clues, but audio is only processed while the game is listening for you; the rest is discarded at once, and nothing is recorded or stored. You can set the microphone to open only while the game listens, or turn it off and type, in Settings. Two recognizers are offered. The **studio ear** downloads the open-source Whisper speech model from Hugging Face once (a plain file download, like the voice) and then transcribes your speech entirely on your computer; no audio leaves the machine. Until it is downloaded, or if you choose it instead, the extension uses **Chrome's built-in recognizer**, which sends microphone audio to Google's speech service while the game is listening; that is governed by Google's privacy policy, not by this extension. You can answer by typing instead, in which case no audio is captured.

The extension does not contact any server of its own. There is no analytics, advertising, or telemetry.

## Permissions

- **Access to j-archive.com game pages:** to add the game to those pages.
- **Offscreen documents:** to run the speech model in a hidden extension page.
- **huggingface.co / hf.co:** to download the speech model at your request.

## Contact

Questions about this policy: use the developer contact on the extension's Chrome Web Store listing, or open an issue at [https://github.com/jmckee1727/j-play-live/issues](https://github.com/jmckee1727/j-play-live/issues).

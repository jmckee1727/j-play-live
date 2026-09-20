# Privacy Policy — J-Play Live

*Last updated: September 19, 2026*

J-Play Live is a browser extension that lets you play along with archived game shows on the J! Archive website (j-archive.com). It runs only on j-archive.com game pages.

## What the extension collects

Nothing. The extension does not collect, store, or transmit any personal information, browsing history, or gameplay data. Your settings (difficulty, voice choice, and similar) are saved in your browser's local storage for j-archive.com and never leave your computer.

## Network activity

The extension makes network requests in exactly two situations:

1. **The studio voice.** If you choose to download the studio voice, the extension downloads the open-source Kokoro speech model files from Hugging Face (huggingface.co and its content-delivery hosts) once and caches them in your browser. These requests are plain file downloads that carry no information about you. After the download, speech is generated entirely on your computer.
2. **Speech recognition.** If you choose to answer by voice, the extension uses the speech recognition built into Chrome. Chrome sends microphone audio to Google's speech service to transcribe it while the game is listening: after you ring in, for a few seconds at a time, and — if you keep "pick clues by voice" on — while you are choosing a clue. This is governed by Google's privacy policy, not by this extension. You can answer by typing instead, in which case no audio is captured.

The extension does not contact any server of its own. There is no analytics, advertising, or telemetry.

## Permissions

- **Access to j-archive.com game pages:** to add the game to those pages.
- **Offscreen documents:** to run the speech model in a hidden extension page.
- **huggingface.co / hf.co:** to download the speech model at your request.

## Contact

Questions about this policy: use the developer contact on the extension's Chrome Web Store listing, or the project's GitHub issues page.

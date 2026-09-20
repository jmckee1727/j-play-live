# Publishing J-Play Live to the Chrome Web Store

## Already done (in this folder)

- **The package:** `dist/j-play-live-<version>.zip`, built by `./build.sh` from exactly the files
  the extension uses (about 6 MB zipped; the 21 MB WebAssembly speech runtime is most of it).
- **Screenshots:** `store/screenshots/1-clue.png` … `5-edit-results.png`, 1280×800, ready to upload.
- **Listing text:** `store/listing.md` — the summary (under 132 characters), the description,
  and the answers for the privacy-practices form.
- **Privacy policy:** `store/privacy-policy.md` and the same text as a standalone web page,
  `store/privacy-policy.html`, ready to host (the contact line points at the store listing's
  developer contact and the project's GitHub issues page).
- **Icons:** `icons/128.png` is in the package and is what the store shows.

## Your part (needs your Google account)

1. **Developer account.** Sign in at https://chrome.google.com/webstore/devconsole and pay the
   one-time $5 registration fee. Verify the contact email. (This is the only step that costs
   anything.)
2. **Privacy policy URL — done.** The repository is https://github.com/jmckee1727/j-play-live with
   GitHub Pages on, so the policy is served at
   https://jmckee1727.github.io/j-play-live/store/privacy-policy.html and the support link is
   https://github.com/jmckee1727/j-play-live/issues.
3. **Upload.** Developer Dashboard → **New item** → upload the zip from `dist/`.
4. **Store listing:** paste the summary and description from `store/listing.md`, upload the
   five screenshots from `store/screenshots/`, category "Fun", language English.
5. **Privacy practices:** answer from the "Privacy practices form" section of `store/listing.md`
   (single purpose, permission justifications, no remote code, no data collected), and paste
   the privacy policy URL.
6. **Distribution:** public, all regions — or **unlisted** first, which gives you a store link
   to share with friends before going fully public (same review either way).
7. **Submit for review.** A first version usually takes a few days. If the reviewer asks why
   the package includes a 21 MB WebAssembly file, the answer is in the listing text: it is the
   on-device speech runtime, and no code is loaded remotely.

## Updates later

Bump `"version"` in `manifest.json` (the store rejects a version it has already seen), run
`./build.sh`, and upload the new zip as an update to the existing item. Users get it
automatically.

## Things to keep in mind

- **Trademarks.** "Jeopardy!" is Jeopardy Productions' trademark. The listing uses the word to
  describe what the extension does (nominative use) and carries the disclaimer; the extension's
  own name is "J-Play Live" and it uses no Jeopardy! logo, fonts, or artwork. Keep it that way.
- **J! Archive.** The extension modifies J! Archive pages in the user's browser, the same way
  the original j-play does. It doesn't scrape, republish, or store the archive's data, and it
  shouldn't be monetized (the archive's terms prohibit that).
- **Sounds.** Ship only the built-in synthesized cues and the original think tune. Don't bundle
  the show's actual music or sound effects.
- **The speech model** is downloaded from Hugging Face at runtime, which the store allows
  (weights are data, not code). Keep `host_permissions` for `huggingface.co` and `*.hf.co`.
- **Licenses.** `vendor/NOTICE.txt` lists the bundled open-source components (Apache 2.0 and
  MIT) and the CC BY 3.0 name data behind `names.js`; the package includes it.

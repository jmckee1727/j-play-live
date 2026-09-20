# Publishing J-Play Live to the Chrome Web Store

## Status

**Submitted for review on September 19, 2026** (version 0.7.5), set to publish automatically once
it passes. Store item ID `knmdbebngmkekoeoaoekogeaipinklnp`; once live the listing will be at
https://chromewebstore.google.com/detail/knmdbebngmkekoeoaoekogeaipinklnp. Publisher account
jmckee1727@gmail.com (contact email verified, declared a non-trader account). The dashboard is
https://chrome.google.com/webstore/devconsole.

What was submitted: the package from `dist/j-play-live-0.7.5.zip` (also kept on the `packages`
branch of the repository and attached to the v0.7.5 GitHub release), the listing text from
`store/listing.md` (category Games, language English), the five screenshots, the small and
marquee promo tiles (`store/promo-*.png`), the privacy form (no remote code, no data collected),
the privacy policy URL, and short test instructions for the reviewer.

## Updates later

Bump `"version"` in `manifest.json` (the store rejects a version it has already seen — and its
`description` must stay under 132 characters), run `./build.sh`, then in the dashboard open the
item → Package → **Upload new package** with the new zip, and Submit for review again. Users get
the update automatically. Commit the new zip to the `packages` branch too if you want the record.

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

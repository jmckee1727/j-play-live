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

## Sharing outside the store (friends and family)

The install page at https://jmckee1727.github.io/j-play-live/ (`index.html`, served by GitHub
Pages from `main`) links to the newest GitHub release's `j-play-live.zip`, which people unzip and
**Load unpacked** in `chrome://extensions`. To publish a new version there:

```sh
./build.sh                                   # dist/j-play-live-<ver>.zip
cp dist/j-play-live-<ver>.zip dist/j-play-live.zip
gh release create v<ver> dist/j-play-live-<ver>.zip dist/j-play-live.zip \
    --title "J-Play Live <ver>" --notes "What changed…"
```

The stable name matters: the page's button points at
`releases/latest/download/j-play-live.zip`, so each new release updates it automatically.
Unpacked copies don't update themselves; the page tells people how to replace the folder.
Once the store listing is live, add the store link to the page and tell people to switch.

## The online service (accounts, lobbies, matchmaking)

Online play runs on a Supabase project, **j-play-live** (ref `ckcgupksgfadhtyhycdl`, us-east-1) in
John's Supabase organization; the dashboard is https://supabase.com/dashboard/project/ckcgupksgfadhtyhycdl.
The free plan covers it (two active projects per organization). What is there:

- **Auth**: email + password accounts. Sign-up goes through the `signup` edge function (public,
  no JWT), which creates the user already confirmed — so no confirmation mail is needed and the
  project's default mail service (rate-limited) is never used — and inserts the profile row.
  `delete_account` (JWT required) removes the caller's account; everything cascades.
- **Tables** (all with row-level security): `profiles` (name, ratings; users can update only
  their name), `results`, `played`, `rooms`, `room_players`, `queue`, `meta` (`max_game_id`).
  Ratings and online results are written only by `finish_room`, a security-definer function the
  host calls with everyone's result; Elo by finishing place (K = 48 for the first ten ranked games,
  32 after) plus the Coryat sums. Other functions: `create_room`, `join_room`, `set_room`,
  `start_room`, `leave_room`, `abandon_room`, `enqueue`, `match_me` (three oldest of a mode, a
  random game in 3000..max_game_id none of them has played), `dequeue`, `reroll_game`,
  `sync_played`, `note_max_game`, `room_state`; the `leaderboard` view.
- **Realtime**: private broadcast channels `room:<id>`; policies on `realtime.messages` let
  only a room's players send and receive. Broadcast delivery is not strictly ordered, so every
  message is keyed (clue, attempt, sender) and the clients' `waitFor` reads from an inbox.
- **Keys**: the extension ships the project URL and the *publishable* key (public by design;
  row-level security is what protects the data). The service-role key lives only in the edge
  functions' environment. Never put it in the extension.
- **Migrations** were applied through the Supabase MCP (`jplay_core`, `jplay_functions`,
  `jplay_realtime_policies`, `jplay_membership_helpers`); the SQL is in the dashboard's
  migration history. `test/online/api.js` and `test/online/e2e_online.js` (three browsers with
  the extension, a lobby game and a ranked match against the live service) are the tests; the
  test accounts are `jplay-test-{ann,bob,cy}@example.com`.
- **Abuse**: an account is an email and a name; there is no email verification, so an abuser can
  make accounts freely. If that becomes a problem, turn on email confirmation (or a captcha) in
  the dashboard and switch the client to the auth service's own sign-up. The correct responses are
  on every player's page, so ranked play is trust plus detection; the `results` table has what a
  statistical check needs (accuracy, reaction offsets can be added to the messages).

## Things to keep in mind

- **Trademarks.** "Jeopardy!" is Jeopardy Productions' trademark. The listing uses the word to
  describe what the extension does (nominative use) and carries the disclaimer; the extension's
  own name is "J-Play Live" and it uses no Jeopardy! logo, fonts, or artwork. Keep it that way.
- **J! Archive.** The extension modifies J! Archive pages in the user's browser, the same way
  the original j-play does. It doesn't scrape, republish, or store the archive's data, and it
  shouldn't be monetized (the archive's terms prohibit that).
- **Sounds.** Ship only the built-in synthesized cues and the original think tune. Don't bundle
  the show's actual music or sound effects.
- **Permissions.** Since 0.10.0 the extension runs a small script (`played.js`) on every
  j-archive.com page, not only game pages, and uses the `storage` permission. Chrome's permission
  warning is per host, so this reads the same to users as before ("read and change your data on
  j-archive.com"); the privacy policy and the listing's "runs only on…" line say what it does there.
- **The speech model** is downloaded from Hugging Face at runtime, which the store allows
  (weights are data, not code). Keep `host_permissions` for `huggingface.co` and `*.hf.co`.
- **Licenses.** `vendor/NOTICE.txt` lists the bundled open-source components (Apache 2.0 and
  MIT) and the CC BY 3.0 name data behind `names.js`; the package includes it.

# Live unfurl verification

Verification for [issue #16](https://github.com/newhoggy/beautiful-html/issues/16),
performed on 2026-10-12 in Australia/Sydney (2026-10-11 UTC), after
[PR #18](https://github.com/newhoggy/beautiful-html/pull/18) deployed the site-base fix.
The live HTML matched the committed HTML at `81c1bda` for all three pages.

The initial live observations below describe the deployed version. The repairs
and current validation are recorded under [Follow-up repairs](#follow-up-repairs).
This is an observation record, not an automated regression test or a guarantee for
other platforms. No social post was published.

## Pages and images

All page URLs below are relative to `https://bitwise.john-ky.io/`. Direct GETs of
all three pages and their `og:image` URLs returned **200 without redirects**.
Each image was `image/png`, 1200 × 630.

| Page | Expected title | Image path | Image bytes |
| --- | --- | --- | --- |
| `docs/token-bucket-rate-limiting.html` | Token bucket rate limiting | `docs/assets/og/token-bucket-rate-limiting.png` | 65,769 |
| `docs/adr-001-rate-limit-in-each-service.html` | ADR-001: Rate limit inside each service | `docs/assets/og/adr-001-rate-limit-in-each-service.png` | 38,174 |
| `docs/gpu-deflate-decoding.html` | Private page | `theme/logo/og.png` | 49,046 |

## Bluesky extractor

GET `https://cardyb.bsky.app/v1/extract?url=<percent-encoded-page-URL>` for each
page. All three responses had an empty `error`, the expected title, description,
and image. GET each returned `image` URL; HEAD is unreliable on this proxy.
All proxy images returned 200 `image/png` and were byte-identical to the direct
images above.

- Diagram: title **Token bucket rate limiting**; description **How a token bucket
  admits bursts but enforces an average rate — with a live simulation,
  implementations, and the mistakes that bite in production.** The returned
  `url` was the final custom-domain page URL.
- ADR: title **ADR-001: Rate limit inside each service**; description **Each
  service enforces its own per-client token bucket in process, so we can ship
  limits before launch without new infrastructure.** The returned `url` was
  the final custom-domain page URL. Image: the framed logo-tile fallback.
- Sealed: title **Private page**; description **This page is private. Open it
  with the full link you were given.** Image: the shared site card. The returned
  `url` was empty, consistent with the shell omitting `og:url` and canonical.
  No private source title, description, author, date, or tags were exposed.

Only extractor responses and their images were inspected for Bluesky; no
rendered Bluesky post was tested.

## LinkedIn Post Inspector

Submitted each final page URL at
[Post Inspector](https://www.linkedin.com/post-inspector/). For each, the
inspector displayed a recent scrape, the correct fetched URL, a single
**206 Success** entry in the redirect trail, and a rendered card. This is
LinkedIn's range-fetch status; direct GETs returned 200.

- Diagram: expected title and description, type Article, author John Ky,
  publication date corresponding to 2026-10-05. Canonical matched the final
  custom-domain URL. The diagram card and full title appeared in the rendered
  preview. The bucket, request/limiter/service/rejection structure is visible;
  **small edge labels and secondary annotations are hard to read at the shown
  size**. Do not treat this as a clean pass for all diagram text.
- ADR: expected title and description, type Article, author John Ky,
  publication date corresponding to 2025-11-12. Canonical matched the final
  custom-domain URL. Both the title embedded in the image and LinkedIn's title
  below it were complete; the logo tile was clear.
- Sealed: title Private page, the fixed generic description, type Article,
  shared site image, no author or publication date, no canonical entry.
  The rendered card showed the site branding with Private page below it.
  LinkedIn warned **The description should be at least 100 characters long.**
  The preview still rendered. This is an optimisation warning, not evidence
  of a privacy leak; the short generic description is intentional.

The preview was inspected at the inspector's displayed size without zooming the
image or substituting a local card recreation. Titles were not clipped.

## Real private-source check

At clean HEAD `81c1bda`, equal to `origin/main`, ran:

```sh
npm run unseal -- gpu-deflate-decoding
npm run check
npm test
```

The unseal command recreated the actual git-ignored private source using its
existing 1Password key. No synthetic source was used, and no plaintext or key
is included in this record.

The private-pages check passed with the source present: the shell matched the
generic shell, its digest matched the real source and key, and the plaintext
source title/description were checked for leaks. No leak was reported.

The complete check returned **14 files, 1 error, 0 warnings**: the historical
private plaintext lacks `<link rel="icon">`. `npm test` returned **3 passed,
1 failed**, because the review-ingestion test also invokes the full check and
sees that same favicon error. These failures predate this verification change;
they were observed before any tracked edits on the exact default-branch commit.
The sealed public shell itself has its icons. During this initial verification,
the private source was not edited or resealed.

## Findings and limits

The two-validator fetch criterion is exercised for all three page types after
#14's deployment. The observations and discrepancies are also recorded on #16.
These findings motivated the follow-up repairs below: the diagram's small
annotations and the pre-existing private-source favicon failure. The description-length warning is retained
because a generic sealed preview works without lengthening it.

No assertion is made about Slack, Discord, X, iMessage, Mastodon, a rendered
Bluesky post, or how future platform layout changes affect these cards.

## Ordinary CI checks

With the restored source temporarily held outside the checkout, matching the
published/CI file set, `npm run check` passed (13 files, 0 errors, 0 warnings),
`npm test` passed all four tests, every script/module passed `node --check`, and
`npm run bundle:all` produced all seven public bundles. The real source was
restored afterward. The source-free run does not supersede the private-input
failure above. The server test needs permission to bind localhost: a sandboxed
attempt failed with `listen EPERM`, and the permitted rerun passed.


## Follow-up repairs

On 2026-10-12 (Australia/Sydney), following the user's instruction to fix the
remaining findings:

- Added the favicon and touch-icon links to the actual private source and
  resealed it with its existing key. A byte comparison proved that removing
  those two inserted links recreates the original source exactly. Decrypting
  the new committed ciphertext recreated exactly the updated source. No other
  private source content changed, and no plaintext or key was committed.
- Enlarged the token-bucket mechanism node labels from 14 to 24 SVG units,
  secondary labels from 12 to 20, and edge labels from 12 to 22. Secondary and
  edge labels now use the theme's text colour for stronger contrast. Shortened
  the refill and capacity labels and adjusted their spacing and node heights
  to fit the larger type. Kept all stepper IDs, arrow paths, and semantics.
- Regenerated the card: 1200 × 630 PNG, 81,340 bytes. Other cards were current
  and unchanged. `npm run index` left generated metadata/data unchanged.

The new card was inspected locally in Chrome at **480 × 252 CSS pixels**, with
no image enlargement: the full title and labels (including refill rate,
capacity, take-one-token, token/empty, and Retry-After) were readable. This was
local preview-size QA, not a new LinkedIn scrape. The actual page was inspected
in light and dark themes; labels were contained in their nodes and arrows were
separate from labels. At a 390-pixel phone viewport, the existing horizontal
scroll region exposed both halves of the diagram. The refill step still
highlighted the appropriate nodes and arrow.

Current validation, with the real private source **present throughout**:

- `npm run check`: **14 files, 0 errors, 0 warnings**, including the real-source
  digest and title/description leak checks.
- `npm test`: **8 passed**, including the additional static-server checks now
  on main.
- `node --check theme/bh.js` and all `theme/modules/*.js` / `scripts/*.mjs`:
  passed.
- `npm run bundle:all`: seven public bundles; no private bundle.
- `npm run visual -- --only token-bucket`: light, dark, and phone cases rendered.
  No baselines existed, so this established baselines rather than proving a
  comparison with the old diagram. Browser inspection supplied visual QA.

The revised card can only be fetched by LinkedIn at the final live URL after
this PR merges and deploys. That re-scrape remains a post-deployment check; the
initial two real-validator fetches above remain the live evidence. The generic
private-description length warning is intentionally unchanged.

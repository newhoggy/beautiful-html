# Live hidden-example verification

Verification for [#26](https://github.com/newhoggy/bitwise-blog/issues/26), performed
on 2026-10-13 (Australia/Sydney). The
[implementation plan](https://github.com/newhoggy/bitwise-blog/issues/26#issuecomment-6141094579)
records scope and limitations. This is partial verification; #26 remains open.

## Deployment and browsers

The origin was **https://bitwise.john-ky.io/**, using normal TLS validation.
`theme/build.js` reported commit
`731f5b79a651e668fd1e5e63b7646a6f63376ace`, the merge of PR #25,
and build time `2026-10-11T14:12:02Z`. Direct GETs of `/` and
`theme/examples.js` were byte-identical to this worktree's copies.

- Google Chrome **155.0.8059.40**, installed application, headless.
- Firefox **153.0**, Playwright's patched Firefox build, headless, downloaded
  into a temporary directory. This exercises Gecko; it is not a manual check
  in a stock Firefox installation or a physical phone.
- Safari **26.5.2 (21624.2.5.11.8)** is installed, but WebDriver session creation
  failed because **Allow remote automation** was disabled. The user approved
  temporary enablement; Safari then required the user to authenticate. No Safari
  result is claimed while that authentication remains outstanding.

## Observations

Each Chrome and Firefox case used a fresh isolated context, light or dark system
colour preference, and a **1280 × 900** or **390 × 900** viewport: eight cases.
The following assertions completed in all eight cases before the JavaScript-error
assertion failed:

| Check | Result in Chrome and Firefox |
| --- | --- |
| Home catalogue | 3 visible cards; none of the four example cards |
| Topic/type chips | No Examples, Decision or Design chips by default |
| Search opened with ⌘K | Empty-query count 3; count 7 with examples enabled |
| Search queries | ADR-001, ADR-002, Moving rate limiting, Token bucket return no example-page URL by default; return examples when enabled |
| Direct URLs | All four show “This is an example page”; their “See the posts” links return to a catalogue with 3 cards |
| Glossary | Rate limiting and Token bucket definitions have no link to the explainer |
| `?examples` | 7 cards, example chips/search results, readable explainer after following a link; source is the remembered session override |
| `?examples=auto` on live origin | Returns to 3 cards/search documents and clears `bh-examples` from sessionStorage |
| `?examples=off` on localhost | 3 cards/search documents; persists on the following query-free navigation |
| `?examples=auto` on localhost | Returns to 7 cards/search documents and clears sessionStorage |
| Viewport | Home and each direct notice retain the requested innerWidth |

The four direct pages checked were:

- `docs/adr-001-rate-limit-in-each-service.html`
- `docs/adr-002-rate-limit-at-the-edge.html`
- `docs/edge-rate-limiting-design.html`
- `docs/token-bucket-rate-limiting.html`

A separate real-origin check held the deferred `theme/bh.js` request while
`theme/examples.js` and CSS loaded. Both browsers reported the policy hidden,
`main` with computed `display: none`, and no notice yet. Releasing initialization
produced the notice. This samples the pre-initialization state; it does **not**
prove that no content ever flashes across every frame of a throttled hard reload.
That visual reload check remains outstanding, as does the Safari matrix.

## Finding: the hidden explainer still runs its simulation initialization

Both browsers emit an uncaught TypeError on a direct default visit to
`https://bitwise.john-ky.io/docs/token-bucket-rate-limiting.html`:

- Chrome: `Cannot read properties of null (reading 'querySelector')`.
- Firefox: `can't access property "querySelector", sim is null`.
- Source: `input()` at line 304, called by the DOMContentLoaded listener at
  line 307 (registered at line 297).

The theme replaces the example article with the notice before the page's own
listener runs. The listener then looks up the removed simulation and dereferences
null. The notice and posts link still work; no content leak was observed. All
eight matrix cases reached the final no-page-errors assertion and failed there,
with two errors per case because the hidden explainer was visited twice.

Suggested repair: have the page's simulation listener return when its simulation
root is absent; verify both a hidden direct visit (no exception) and an enabled
example (simulation works). No production fix is included in this verification
PR. A separate follow-up issue has not been created: the invoked issue-to-pr
skill prohibits touching other issues. The reproduction is recorded on #26 and
in the PR, and this acceptance item remains open.

## Reproduction

The optional `scripts/verify-hidden-examples.mjs` harness uses Playwright supplied
outside the site, so no package dependency or lockfile is added. It checks Chrome
and Firefox only. For example, with an existing Playwright installation:

```sh
export BH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
export PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/playwright-browsers
export BH_LIVE_OUTPUT=/absolute/path/to/scratch/evidence
node /absolute/path/to/worktree/scripts/verify-hidden-examples.mjs
```

Install Playwright's Firefox into that browser directory before running. Chrome
uses `findChrome()` / `CHROME_PATH`, as the other browser scripts do. The harness
writes viewport screenshots and `results.json` under `BH_LIVE_OUTPUT` (default
`.visual/hidden-examples-live`, ignored by git). It exits **1** on the live
simulation error described above. Network failures or a changed deployment also
fail assertions; inspect results rather than assuming this finding is the cause.

Evidence was captured locally under `/private/tmp/issue-26-final-evidence`.
The Chrome dark phone notice screenshot was inspected: notice text and the
posts link fit without horizontal overflow. Screenshots are temporary evidence,
not committed baselines or a claim of manual inspection of every browser case.

## Repository checks

- `npm test`: **21 passed**.
- `npm run check`: **13 files, 0 errors, 0 warnings**.
- `node --check theme/bh.js` and every `theme/examples.js`, `theme/modules/*.js`,
  `scripts/*.mjs`: passed.
- `npm run bundle:all`: **7 public bundles**.
- `npm run visual -- --system-fonts`: **18 cases rendered**. No baselines existed,
  so this established baselines rather than comparing against a prior rendering.

No private plaintext was restored for this task. Existing sealed-shell checks
ran; no claim is made about repeating a real private-source verification.

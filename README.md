<img src="theme/logo/mark-tile.svg" alt="Bitwise Engineering logo" width="72" align="right">

# Bitwise Engineering

A software engineering blog on **functional programming**, **succinct data structures** and
**AI workflows**. Every post is a self-contained, interactive HTML page: explainers, design
docs, decision records, incident reviews and change walkthroughs, with one consistent theme.

**Live site: [bitwise.john-ky.io](https://bitwise.john-ky.io/)**
Start with the [component gallery](https://bitwise.john-ky.io/docs/component-gallery.html)
to see what a page can do. The old `newhoggy.github.io/beautiful-html` address redirects there.

The theme and toolkit that build the site are called **beautiful-html**. Their names stay:
the `bh` / `bh-*` prefixes (`bh.css`, `bh.js`, `bh:` meta tags, the `bh-review/1` format) and the
`beautiful-html private page: <slug>` 1Password item titles are implementation, baked into
every page and key, so the rebrand changes the site's name and not these.

- **No build step to write.** Pages are plain HTML. Open one straight from disk.
- **One theme.** Design tokens drive typography, colour (light and dark), spacing and motion.
- **Interactive where it helps.** Diagrams you can step through, live parameter
  playgrounds, tabs, predict-then-reveal panels.
- **Works without JS.** Steppers become numbered lists, tabs become sections, and nothing is hidden.
- **Shareable.** `bundle` inlines everything into one `.html` file you can send to anyone.
- **Rich link previews.** Every page unfurls into a card in Slack, Discord, LinkedIn, X and the
  rest, with no work from the author (see [Social cards](#social-cards)).
- **Private pages.** A page written as `docs/<slug>.private.html` is never committed. `seal`
  publishes an encrypted copy that opens only from its `#k=<key>` link, with the key kept
  in 1Password. `unseal` recovers the source from that copy (see CLAUDE.md).

## Topics, examples and the site address

- **Topics.** A post joins a topic by carrying its name in `bh:tags`: `functional
  programming`, `succinct data structures` or `ai workflows`. The home page's topic chips
  are built from those tags (a topic with no posts yet gets no chip).
- **Examples.** The rate-limiting design doc, its two ADRs and the token-bucket explainer
  are worked examples of the document kinds, not posts. They carry `<meta name="bh:example"
  content="true">`. On a local host (`npm run serve`, `file://`) they appear as always, labelled
  "Example · …"; on the published site they are hidden from the home page, search and
  backlinks. Pages deployment removes their HTML and social cards, so their addresses return
  404. `?examples` and `?examples=off` switch the view in the local source copy; they cannot
  restore files omitted from the deployed site (see CLAUDE.md, "Example pages").
- **Address.** The repository, and so the Pages URL, keep the name `beautiful-html`. Renaming
  the repo would break every Pages link, including private-page `#k=` links already shared
  (GitHub redirects the repo URL but not Pages). If the blog gets its own address, use a
  custom domain rather than a rename.

## Social cards

Paste any page's link into a chat and it unfurls as a 1200×630 card: the page's title, kind and
date on a branded frame, around **a picture taken from the page itself**, the first diagram or
image. Two generated pieces make that work, and an author writes neither.

- **Meta tags.** `npm run index` writes the Open Graph and Twitter tags (`og:title`,
  `og:description`, `og:url`, `og:image`, `canonical`, `article:*`, `twitter:card`) into each
  page's `<head>` between two `bh:social` markers, from the page's own `title`, `description` and
  `bh:*` metas. `npm run check` fails when they are missing or stale.
- **Card images.** `npm run cards` renders `docs/assets/og/<slug>.png` in your local Chrome, and
  skips cards that are already current. Commit the PNGs with the page. `check` fails when one
  is missing or stale (it hashes the chosen visual, the title, kind, date and the card layout,
  and needs no browser). Without Chrome, `cards` falls back to the shared site card; `check`
  only warns locally, and fails in CI.

The picture is the first of: a `<meta name="bh:image" content="#figure-id">` override (or an
image path), the first `<figure>` with a diagram or image, a standalone `<img>`, the hero glyph,
and the logo tile. A theme change makes every card stale, so re-run `npm run cards` after one. Set `bh:image` when the automatic pick isn't the page's best picture.

The site address the tags use is `homepage` in `package.json`; a fork changes that (or sets
`BH_SITE_URL`). Private pages unfurl as one generic "Private page" card and reveal nothing.
CLAUDE.md has the full contract.

## Quick start

```bash
open index.html                                     # or: npm run serve → http://localhost:8000
npm run new -- explainer consistent-hashing "Consistent hashing"
npm run check                                       # lint links, ids, stepper refs, a11y basics
npm run cards                                       # render each page's social card (needs Chrome)
npm run bundle -- docs/consistent-hashing.html      # → dist/consistent-hashing.html
npm run seal                                        # encrypt docs/*.private.html (keys in 1Password)
npm run unseal                                      # recreate docs/*.private.html from sealed pages
npm run visual                                      # screenshot diff vs your baselines (Node ≥ 22 + Chrome)
```

Node ≥ 20 is the only requirement. There are no npm dependencies. (`cards` and `visual` also
need Node ≥ 22 and a local Chrome.)

## Continuous integration & publishing

- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request. It
  syntax-checks every script, runs `npm run check` (which also verifies each page's social
  meta and card), uploads all documents bundled as single files, and renders every page in
  Chrome (light, dark and phone layouts).
- **GitHub Pages** (`.github/workflows/pages.yml`) publishes a copy of the repo to
  [bitwise.john-ky.io](https://bitwise.john-ky.io/), with
  a publication step that removes marked examples and their cards, strips links to them, and
  rebuilds the catalogue, glossary, search, backlinks and review data. Source files remain
  unchanged. The step fails if it finds no examples or an expected page/card is missing.
  It stays off until you opt in:
  1. Go to Settings → Pages and set the source to **GitHub Actions**.
  2. Add the repository variable `PAGES_ENABLED=true`.
  The custom domain is a Pages setting (Settings → Pages → Custom domain, plus DNS), not a file in
  the repo. Pages also work under a project sub-path such as `/beautiful-html/`; a fork sets
  `homepage` in `package.json` (or `BH_SITE_URL`) to wherever it is served from.

## Layout

```
index.html              Catalogue of docs (list generated by `npm run index`)
docs/                   One HTML file per document (flat, kebab-case slugs)
  assets/og/<slug>.png  Generated social card of each page (`npm run cards`; committed)
  component-gallery.html  Every component, rendered live — the visual reference
  glossary.html         Shared term definitions (source for every page's term popups)
  token-bucket-rate-limiting.html  Worked example explainer
templates/              Starting points, one per document kind
  explainer.html  design-doc.html  adr.html  incident.html  review.html
theme/
  bh.css                Entry point: imports the layers below
  tokens.css            Design tokens (colour, type scale, space, motion)
  base.css              Reset, typography, buttons, focus, reduced motion
  layout.css            Top bar, TOC, article breakout grid, hero, sidenotes
  components.css        Callouts, cards, compare, timeline, tables, tabs, stepper, playground…
  diagrams.css          Inline-SVG vocabulary: .node .edge .zone .label + stepper states
  glossary.css          Glossary terms, definition popup, glossary lists
  glossary.js           GENERATED from docs/glossary.html by `npm run index`
  site.js               GENERATED: page metadata and backlinks
  search-index.js       GENERATED: full-text search index (loaded on first search)
  reviews.js            GENERATED: published review threads from reviews/
  print.css             Print: chrome removed, all steps and tabs expanded
  bh.js                 Runtime: chrome, TOC/scroll-spy, web components, lazy Prism/Mermaid
  examples.js           Early <head> script: which hosts show example pages (and the ?examples override)
theme/modules/          On-demand components (loaded only by pages that use them)
reviews/schema.json     Format of exported review files (bh-review/1)
reviews/inbox/          Where review files arrive, via pull request
scripts/bh.mjs          CLI: new · index · check · cards · bundle · seal · unseal · serve
scripts/cards.mjs       Social card renderer (used by `bh cards`): visual screenshot + branded frame
scripts/chrome.mjs      Finds and drives a local Chrome over the DevTools protocol (visual, cards)
scripts/visual.mjs      Visual regression: Chrome via DevTools protocol, PNG diff, HTML report
dist/                   Bundled single-file outputs (git-ignored)
```

`npm run serve` and the static server used by visual/card rendering allow symlinks
only when their canonical targets stay within the canonical served root. A root
reached through a symlink is supported. Outside file or directory targets (including
CLI directory indexes) return 403; missing, dangling or looping paths return 404.
These preview servers assume the filesystem is not being changed by a hostile local
process while requests are served.

## Document kinds

| Template     | `bh:kind`   | Use it for                                                   |
| ------------ | ----------- | ------------------------------------------------------------ |
| `explainer`  | `explainer` | Teaching one concept: mental model → mechanism → hands-on    |
| `design-doc` | `design`    | Proposing a design: problem, goals, design, alternatives     |
| `adr`        | `decision`  | Recording one architecture decision and its consequences     |
| `incident`   | `incident`  | Blameless incident review: timeline, root cause, actions     |
| `review`     | `review`    | Change walkthrough or code review: shape, walkthrough, findings |

## What you get on every page

- **Automatic chrome:**
  - sticky top bar with theme toggle (auto → light → dark)
  - reading-progress bar
  - skip link
  - table of contents with scroll-spy, as a sidebar on wide screens and a drop-down on narrow ones
  - `§n` section eyebrows
  - copy-link controls on every section, figure and glossary entry; arriving at a
    `#id` link opens whatever hides the target and highlights it
  - meta row (status, date, authors, reading time) filled from `<meta name="bh:*">`
- **Components** (see `docs/component-gallery.html`):
  - `.tldr`, `.callout`, `.badge`
  - `.cards`, `.metrics`, `.compare`/`.option`, `.decision`
  - `.steps`, `.timeline`, `.kv`, tables
  - `details.disclosure`, `details.predict`
  - code blocks with copy buttons and lazy syntax highlighting
  - annotated code markers, diffs
  - sidenotes
  - `<bh-tabs>`, `<bh-stepper>`, `<bh-playground>`
- **Decision lifecycle:** ADRs link with `bh:supersedes` / `bh:superseded-by`; superseded
  ones carry a banner pointing at their replacement, and `check` keeps both sides in step.
- **Search and backlinks:** ⌘K/Ctrl+K searches every section of every page and the
  glossary; each page lists the pages that link to it ("Referenced by").
- **Presentation mode:** any page becomes slides (one per section) from the top bar or
  `?present`, with keyboard and swipe navigation and the URL following the slide.
- **Reviews:** readers comment directly on the page (select text, or "+ Comment" on a
  section). Comments persist in their browser and export as a JSON review file, stamped
  with the commit and the exact text range, ready to attach to a pull request for a person
  or an agent to apply (`reviews/schema.json`). Once merged, comments appear on the
  published page as threads that anyone can reply to and resolve, using the same flow.
- **Glossary:** terms defined once in `docs/glossary.html` are underlined automatically
  across every page. Hovering, focusing or tapping one shows its definition in a popup
  that stays put. You can move the pointer into the popup to select and copy text or
  follow its links. Clicking or pressing Enter pins it.
- **Charts:** `<bh-chart type="line|bar">` turns a table into a themed chart, with a
  crosshair tooltip, keyboard reading, and the table kept under "Show data".
- **Decision matrices:** `<bh-matrix>` turns a scoring table into adjustable weights with
  live weighted totals and the current leader marked.
- **Code walkthroughs:** `<bh-codewalk>` pins the code beside the prose; scrolling
  through the steps highlights each step's lines and shades the rest.
- **Sequence diagrams:** `<bh-sequence>` draws actors, messages, replies and notes in the
  theme, and can be stepped through like any diagram.
- **Current vs proposed:** `<bh-versions>` switches between versions of a diagram, or
  compares two with a draggable divider, and highlights `data-change` parts.
- **Diagram references:** `data-ref="figure-id:part-id"` on a phrase lights that part of
  the diagram on hover and brings the diagram into view on click.
- **Diagrams:** inline SVG using theme classes. Arrowheads are automatic, and every
  diagram follows light/dark. `<bh-stepper for="id">` lights up parts of a diagram
  step by step. Mermaid is available as a fallback.
- **Motion:** scroll reveal for content below the fold, flow animation on lit
  edges, tab and step transitions. All of it is disabled under `prefers-reduced-motion`.

See [CLAUDE.md](CLAUDE.md) for the house style used when writing pages, by hand or with an agent.

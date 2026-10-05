# beautiful-html: house style

This repo produces technical documents as HTML pages that share one theme. These
rules apply to every page, whether a person or an agent writes it. The live
reference for every component is `docs/component-gallery.html`. Copy markup
from it rather than inventing new markup.

## Workflow

1. `npm run new -- <template> <slug> "<Title>" "<one-sentence description>"`
   - Templates: `explainer`, `design-doc`, `adr`, `incident`, `review`
   - This creates `docs/<slug>.html` and refreshes `index.html`
2. Replace every placeholder section. Delete sections that don't earn their place.
3. `npm run check`. It must report 0 errors. Fix the warnings unless there is a reason not to.
4. Open the page in a browser and check both themes and a narrow (phone) width.
   A clean `check` says nothing about rendering, so never skip this step. See
   [Verifying changes](#verifying-changes).
5. For sharing outside the repo, run `npm run bundle -- docs/<slug>.html` and send `dist/<slug>.html`.

Run `npm run index` after changing any page's title, description or `bh:*` meta, and
after editing `docs/glossary.html`. Index also compiles `theme/glossary.js`.

## Page contract

- Pages are flat files in `docs/` and link `../theme/bh.css` and `../theme/bh.js`. Don't add a build step.
- Keep the `<head>` from the template:
  - `title` and `description`
  - `bh:kind`, `bh:status`, `bh:date` (YYYY-MM-DD), `bh:authors`, `bh:tags`
  - the inline theme script that prevents a flash of the wrong theme
- Use exactly one `<h1>`, inside `.bh-hero`.
- Content lives as **direct children** of `<article class="bh-article">`. Don't wrap
  sections in `<section>` or `<div>`. The TOC, eyebrows and breakout grid all rely on this.
- **Everything a reader might want to share must be linkable.** That means each of these
  gets an explicit, stable, kebab-case `id` (`a-z`, `0-9`, hyphens):
  - every section heading (`h2`, `h3` and `h4` placed directly in `.bh-article`)
  - every `<figure>`, which includes every diagram
  - every glossary `<dt>`
  - any other block you'd want to point at (a table, a playground, a callout): add
    `data-linkable` and an `id`.
  - every stepper step, automatically: `<bh-stepper for="figure-id">` makes each step
    linkable as `#figure-id-step-N`. A stepper must therefore have `for` (or an `id`).
  - `npm run check` fails when one of these is missing an id or uses a non-kebab id.
    Headings inside components (cards, options) are not sections and are exempt.
- The theme provides the "copy link" controls, so never hand-roll them:
  - Headings and glossary entries show `#` on hover.
  - Figures and `data-linkable` blocks show a link button in the corner.
  - Clicking either copies the full URL, puts `#id` in the address bar, and confirms with
    a toast. Arriving at `#id` opens any `<details>`, tab or stepper step that hides the
    target, scrolls to it and briefly highlights it.
- **Ids are permanent once published.** Pick ids that name the concept, not the wording:
  `#rollout`, not `#how-we-plan-to-roll-this-out`. If you must rename one, keep the old
  id working with an empty `<span id="old-id"></span>` placed right before the target.
- Width: the default is the reading column. Use `.wide` for figures, tables,
  comparisons and playgrounds. Use `.full` rarely.
- Put page-specific CSS in one `<style>` in `<head>`, scoped by id. Put
  page-specific JS in one `<script>` before `</body>` that runs on `DOMContentLoaded`.
  Never edit the theme to serve a single page.

## Writing

- Order the content: **orientation → mental model → mechanism → hands-on → details → edge cases → further reading.**
- Open with a `.tldr` of no more than 3 bullets: the answer, why it matters, and the common mistake.
- Explain *why* at every step, not only *what*. Use real numbers, units and names.
- Put asides in `.sidenote`, not in parentheses. Put depth for the curious in `details.disclosure`.
- Use `details.predict` once or twice per page. Asking the reader to predict before
  revealing the answer is the cheapest form of active learning.

## Choose the form from the content

| Content                           | Use                                                        |
| --------------------------------- | ---------------------------------------------------------- |
| Options / trade-offs              | `.compare` with `.option` (mark the pick `.chosen`) + `.pros`/`.cons` |
| A decision                        | `.decision` (one sentence: "We will … because …")          |
| A process the reader performs     | `ol.steps`                                                 |
| A process a system performs       | SVG diagram + `<bh-stepper for>`                           |
| Messages between parties over time | `<bh-sequence>` in a `figure.diagram` (+ `<bh-stepper for>`) |
| Events in time                    | `ol.timeline` (`.danger` / `.warn` / `.ok` on items)       |
| Numbers that matter               | `.metrics` tiles; tables for anything with more than one dimension |
| Parallel variants (languages, APIs) | `<bh-tabs>`                                              |
| How an implementation works, step by step | `<bh-codewalk id>`: one `pre>code` + `bh-cw-step lines="3-8"` |
| A relationship between parameters | `<bh-playground>` with `data-expr` / `data-bind`           |
| Facts about a thing               | `dl.kv`                                                    |
| A change to a system (before/after) | `<bh-versions>` with one `figure` per version (`data-label`), parts marked `data-change` |

**One centrepiece interactive per page.** One interaction that changes understanding
beats five decorative ones.

## Diagrams

- Draw inline SVG with theme classes, never hard-coded colours:
  - `<g class="node cN" data-id="…">` wrapping a shape plus `<text>`
  - `<path class="edge" data-id="…">`, which gets an arrowhead automatically
  - `.zone` with `.zone-label` for boundaries; `.label` for annotations
- Give colour a meaning and keep it fixed across the repo:
  - `c1` our system
  - `c2` data and storage
  - `c3` external
  - `c4` failure
  - `c5` network
  - `c6` infrastructure
- **The line stops where the arrowhead begins.** It meets the centre of the head's base at
  a right angle, and it never runs under the head: a stroke reaching the tip blunts the point.
  - The head is 10 units long. Its base sits on the path's end point and it points along
    the path's final direction, so this holds automatically, even for a path ending in a curve.
  - So **end every arrowed path 10 units short of where the tip should land**, which is
    11 short of the target's outline (the tip touches the node's stroke). For example, to
    point right at a node whose left edge is `x=600`, end the path at `x=589`. A curve can
    flow straight into the head: `M550 105 C570 105 570 54 589 54`.
  - `.edge.both` follows the same rule at its start as well.
  - `npm run check` enforces this. It projects each arrow tip and fails when a tip pokes into
    a node, or stops more than 2 units short of the node it points at. Tips aimed at
    non-rectangular shapes can't be verified, so check those by eye.
- **Labels never touch a line or arrowhead.** Place each label in open space beside its edge,
  not on the edge's path. Whenever you move an edge, re-check every label near it: moved
  curves have run straight through labels that used to be clear.
- Pad the `viewBox` by at least 16 (`viewBox="-16 -16 W+32 H+32"`) so strokes and labels never clip.
- Every diagram's `<svg>` gets `role="img"` and an `aria-label` describing what it shows.
- **Point at diagram parts from the prose.** When the text names a part of a diagram,
  wrap the phrase: `<span data-ref="figure-id:part-id [part-id…]">the gateway</span>`.
  - Hover or focus lights those parts; click brings the diagram into view.
  - Include the edges that make the point, not just the nodes.
  - `npm run check` fails when the figure or a part id doesn't exist.
- A figcaption says what to *notice*, not what the picture is.
- For message exchanges, use `<bh-sequence>` (actors, `bh-msg from/to [reply]`,
  `bh-note over`), not Mermaid. Give every part a `data-id` that a stepper or a
  `data-ref` can use. It renders at natural size (1 unit = 1px), so keep labels short.
- Mermaid (`<pre class="mermaid">`) is a fallback for quick state or flow sketches only.

## Glossary

- **`docs/glossary.html` is the only place terms are defined.** It holds one
  `<dt id="kebab-id" data-aliases="plural, other spelling">Term</dt><dd>…</dd>` per term,
  kept A–Z. `npm run index` compiles it into `theme/glossary.js`. That file is generated,
  so never edit it by hand.
- Defined words are underlined automatically in article prose: the first occurrence per
  page, and the first per definition on the glossary page itself. Hover, focus or tap
  shows the definition.
- Change the marking per page with `<body data-glossary="page|section|every|off">`.
  Force a mark with `data-term="id"`; keep a passage unmarked with `class="no-glossary"`.
  Headings, links, code, labels, `summary` and diagrams are never marked.
- Definitions: one to three plain sentences a newcomer can follow, then a link to go
  deeper. Write relative links relative to `docs/`; they are rebased for other pages.
- List every plural and alternate spelling in `data-aliases`, because matching is
  whole-word and case-insensitive. Never let a name or alias belong to two terms;
  `check` fails on that.
- A page may add its own terms with a local `<dl class="glossary">`. These override
  shared terms with the same id on that page only.
- **Popup behaviour is a contract. Keep it when changing `bh.js`:**
  - It is placed once when it opens and never follows the pointer.
  - The pointer can cross the gap into it (an invisible bridge plus a hide delay).
  - Pressing inside it, clicking the term, or Enter/Space pins it until Esc or a click
    elsewhere.
  - Esc returns focus to the term without reopening the popup.

## Motion & interaction

- Animation must explain something: flow along an edge, state changing between
  steps, a value responding to input. Never animate for decoration.
- The theme already handles reveal-on-scroll, tab and step transitions, and edge flow.
  Don't add more.
- Everything respects `prefers-reduced-motion`, and every page must still read
  correctly with JavaScript disabled.
- Controls are real `<button>` and `<input>` elements, with visible labels and the keyboard working.

## Page scripts & simulations

- If a simulation pauses while offscreen (it should, via `IntersectionObserver`), then on
  resume reschedule future events from *now*. Otherwise the events that piled up while
  paused all fire in one frame: a token bucket drained in one burst this way.
- Advance the model's state up to each event's own timestamp before handling that event,
  rather than once per frame. Batch updates give results the real algorithm never would.
- Read inputs from the DOM, or listen for `bh-change` events. Don't assume a component has
  already initialised when your script runs.

## Accessibility & quality bar

- Text contrast is at least 4.5:1 in **both** themes. Use only the theme tokens (`var(--text)`, `var(--c2)`…).
- Never use colour alone to carry meaning: pair it with a label, an icon or a position.
- Every `<img>` has an `alt`, and every `<svg>` diagram has an accessible name.
- Check the page at 375px wide: no horizontal page scroll. Wide tables scroll inside `.table-wrap`.

## Changing the theme

Theme files (`theme/*`) are shared by every page. These rules come from bugs already hit here:

- **In `bh.css`, the `@layer` statement must come before every `@import`.** An `@import`
  that follows any other rule is silently ignored, and the whole theme vanished that way.
- **`!important` reverses inside cascade layers:** an important declaration in an *earlier*
  layer beats one in a later layer. Prefer specificity or layer order; use `!important`
  only to beat the generic article spacing rules.
- **CSS counters skip `display: none` elements.** Anything numbered while hidden (stepper
  steps, tabs) must take its number from a `data-*` attribute that JS sets.
- **Generic article rules leak into components.** `.bh-article li + li` and the flow
  margins apply to every list and child. A component built from lists or grid items must
  reset `margin` on its own items. A missing reset knocked cards out of line.
- **Grids of cards use `auto-fit`, not `auto-fill`.** `auto-fill` leaves empty tracks, so
  a short row doesn't stretch to fill the width.
- **Components must work when `bh.js` runs before the body is parsed.** Bundled pages
  inline the script, so `connectedCallback` must defer to `whenReady()` before reading its
  children.
- **Larger components are on-demand modules** in `theme/modules/*.js`, registered in
  `MODULES` in `bh.js` with the selector that triggers them. A module must be a classic
  script that uses `window.bh` and sets `window.bhModules[file] = true`. `bundle`
  inlines every module.
- **Don't set up state only in observer callbacks.** `IntersectionObserver` and
  `ResizeObserver` fire on rendering frames, which can be throttled. Create observers and
  initial state synchronously during setup, and let callbacks refine them. A walkthrough
  once never created its step detector for exactly this reason.
- **Readiness:** async work (scripts, rendering) must be wrapped in `bh.settle(promise)`,
  so that `<html data-bh-ready>` only appears once the page has truly settled.
  Screenshot tests rely on it.
- **Diagram colour overrides belong in `diagrams.css`.** Layers beat specificity, so a
  stroke rule in `components.css` loses to `.node.cN` in the later diagrams layer.
  `data-change` marks once rendered in the wrong colour for exactly this reason.
- **Keep geometry constants in sync.** The arrowhead size in `bh.js` markers must equal
  `ARROW_LEN` in `scripts/bh.mjs`. The popup's `--gap` in `glossary.css` must equal
  `GAP` in `bh.js`.
- **Moving focus fires focus handlers synchronously.** Code that closes a popup and then
  focuses its trigger must stop the trigger's focus handler from reopening it. Esc once
  did nothing for exactly this reason.
- **Resetting a component's margins can remove the article flow spacing.** Reset only the
  sides the flow doesn't own; for example, use `margin-inline: 0`, not `margin: 0`.
- After any theme change, re-check `docs/component-gallery.html`. It is the regression page
  for every component.

## Verifying changes

- **Render it.** Lint and syntax checks passed while the page rendered completely unstyled.
  Look at the result in a browser (`npm run serve`) in both themes and at 375px wide.
- **Follow your own links.** Open the page at `#id` for a section and for a figure, and
  confirm each target lands just below the top bar and is visible, not still fading in.
  Click a heading's `#` and a figure's link button: the toast should confirm, the address
  bar should change, and the page should not jump.
- **Zoom in on details.** Problems like a blunted arrow tip, a line hitting an arrowhead off
  centre, or a label crossing a line are invisible at page scale. Use a zoomed screenshot
  of each diagram, in both its normal and its stepper-lit state.
- **Exercise interactions:** step through steppers, switch tabs, move sliders, and leave a
  simulation offscreen and come back.
  - For the glossary popup:
    - Hover a term.
    - Move into the popup, onto its link.
    - Drag-select text and then move away; the popup should stay pinned.
    - Press Esc after the selection.
    - Use the keyboard: Tab to a term, then Enter, Tab and Esc.
    - Hover a term near the bottom-right corner; the popup should flip above it and stay
      inside the window.
- **When testing the checker with injected faults, assert the injection happened.** A
  replacement anchored on stale text matched nothing, and the "test" passed while
  checking nothing.
- **Screenshots can re-lay out the page.** The screenshot tool may capture at a different
  viewport width than the page sees, which reflows text above the target and moves it.
  Verify scroll positions by sampling `getBoundingClientRect()` inside the page, not from a
  screenshot.
- **Browser automation can mislead.** `requestAnimationFrame` is throttled while a script
  awaits in a background or automated tab, so live readouts can show stale zeros. Smooth
  scrolling may not advance at all, and scroll-reveal fades may never finish. To check
  logic, use `behavior: "instant"` and clear `.reveal-pending`. Confirm the real motion
  by eye in a foreground tab.
- Leave no test state behind: clear a forced theme (`localStorage` key `bh-theme`), close
  test tabs, stop `serve`, and delete throwaway pages, then run `npm run index` again.

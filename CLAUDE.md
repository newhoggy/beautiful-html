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
5. For sharing outside the repo, run `npm run bundle -- docs/<slug>.html` and send `dist/<slug>.html`.

Run `npm run index` after changing any page's title, description or `bh:*` meta.

## Page contract

- Pages are flat files in `docs/` and link `../theme/bh.css` and `../theme/bh.js`. Don't add a build step.
- Keep the `<head>` from the template:
  - `title` and `description`
  - `bh:kind`, `bh:status`, `bh:date` (YYYY-MM-DD), `bh:authors`, `bh:tags`
  - the inline theme script that prevents a flash of the wrong theme
- Use exactly one `<h1>`, inside `.bh-hero`.
- Content lives as **direct children** of `<article class="bh-article">`. Don't wrap
  sections in `<section>` or `<div>`. The TOC, eyebrows and breakout grid all rely on this.
- Every `<h2>` gets an explicit, stable `id` (kebab-case), so deep links survive edits.
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
| Events in time                    | `ol.timeline` (`.danger` / `.warn` / `.ok` on items)       |
| Numbers that matter               | `.metrics` tiles; tables for anything with more than one dimension |
| Parallel variants (languages, APIs) | `<bh-tabs>`                                              |
| A relationship between parameters | `<bh-playground>` with `data-expr` / `data-bind`           |
| Facts about a thing               | `dl.kv`                                                    |

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
- Pad the `viewBox` by at least 16 (`viewBox="-16 -16 W+32 H+32"`) so strokes and labels never clip.
- Every diagram's `<svg>` gets `role="img"` and an `aria-label` describing what it shows.
- A figcaption says what to *notice*, not what the picture is.
- Mermaid (`<pre class="mermaid">`) is a fallback for quick sequence or state diagrams only.

## Motion & interaction

- Animation must explain something: flow along an edge, state changing between
  steps, a value responding to input. Never animate for decoration.
- The theme already handles reveal-on-scroll, tab and step transitions, and edge flow.
  Don't add more.
- Everything respects `prefers-reduced-motion`, and every page must still read
  correctly with JavaScript disabled.
- Controls are real `<button>` and `<input>` elements, with visible labels and the keyboard working.

## Accessibility & quality bar

- Text contrast is at least 4.5:1 in **both** themes. Use only the theme tokens (`var(--text)`, `var(--c2)`…).
- Never use colour alone to carry meaning: pair it with a label, an icon or a position.
- Every `<img>` has an `alt`, and every `<svg>` diagram has an accessible name.
- Check the page at 375px wide: no horizontal page scroll. Wide tables scroll inside `.table-wrap`.

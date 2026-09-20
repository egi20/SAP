# DESIGN.md — SAP Hub brand & UI reference

The single source of truth for how anything user-facing should look. **Read this before
building any new page, form, card or widget.** The implementation is
`public/css/style.css` (tokens at the top, components by section); this file states the
rules that are not visible in the CSS.

Ported from the DynamicsHub design system by way of Salesforce Hub. The structure,
component names and rules are theirs; the palette is not, because a site in somebody
else's blue reads as somebody else's site. Every ratio quoted below was measured with
`utils/contrast.js`, not estimated.

## Brand essence

- **Name:** SAP Hub. The wordmark is one word — `SAP` in navy, `Hub` in the blue gradient
  (`.navbar-brand .accent`), or `.brand-accent` on a dark ground where a gradient would
  disappear.
- **Personality:** professional, modern, calm. Premium glassmorphism — frosted white cards
  over soft navy/blue washes. No loud colour, no gimmicks.
- **Not affiliated with SAP SE.** The footer says so on every page. Never imply otherwise
  in copy, and never use SAP's own logo, wordmark or product logos. "SAP", "S/4HANA",
  "SuccessFactors", "Ariba", "Concur" and "Fieldglass" are SAP SE's trademarks and appear
  here only to describe the work people do.

## Colour system (use the variables, never a raw hex)

| Token | Value | Use |
|---|---|---|
| `--primary-navy` | `#00265B` | Headings, dark surfaces, brand primary. 14.70:1 on white |
| `--primary-navy-light` / `-dark` | `#0A4C9B` / `#001739` | Gradient stops |
| `--primary-blue` | `#0064D9` | **Link colour and primary CTA.** 5.49:1 on white |
| `--primary-blue-dark` | `#004AA8` | Link and button hover. 8.25:1 |
| `--primary-blue-light` | `#0070F2` | SAP-family accent and gradient stop |
| `--primary-blue-bright` | `#7AC5FF` | Accent on dark grounds only. 7.88:1 on navy |
| `--accent-gradient` | `#0064D9 → #0A4C9B` | `.btn-primary`, icon tiles, highlights |
| `--navy-gradient` / `--hero-gradient` | navy 135° gradients | `.page-header`, `.hero` |
| `--text-dark` / `--text-medium` / `--text-light` | `#16191D` / `#444C56` / `#5A6673` | Body tiers — 17.63:1, 8.70:1, 5.86:1, all AA on white |
| `--text-muted` | `#8A94A0` | 3.08:1 — **large text and non-essential marks only** |
| `--grad-blue/navy/navyblue/violet/amber/success/info/rose` | sanctioned accents | **Only** for `.icon-tile` colour modifiers |

Rules:

- **`#0070F2` is the accent, not the button fill.** SAP's own brand blue measures 4.57:1
  on white. That passes AA — by seven hundredths. A threshold that tight survives nothing:
  not a hover state, not a disabled opacity, not a designer nudging one channel. So the
  interactive blue is `#0064D9` at 5.49:1, and `#0070F2` earns its place as a gradient stop
  and an accent where nothing has to be read against it. This is the same *kind* of
  decision Salesforce Hub made about `#00A1E0`, reached by measuring rather than by copying
  its conclusion — theirs failed outright at 2.93:1, ours passes and is still refused.
- **Never introduce a foreign palette.** No Tailwind emerald, no Material purple, no
  Bootstrap-4 `#28a745`/`#17a2b8`/`#007bff`.
- Bootstrap's `--bs-primary` is remapped to `#0064D9` globally, so `.text-primary`,
  `.bg-primary` and `.badge.bg-primary` are on-brand and safe.
- Selected card state is **blue border + blue tint** (`.glass-card.is-selected`), never a
  navy wash.
- Links **darken** on hover (`--primary-blue-dark`). Never lighten — a lighter link on
  white loses contrast at the moment the user is aiming at it.
- Documents (SOW, WBS, deck) use `utils/documents/brand.js`, not this file. That is the
  *document* voice. The hexes are kept in step by hand; if you change one, change both.
- A colour a COMPANY supplies for its own documents is measured, not trusted. Below 4.5:1
  on white it is refused with its measurement shown. The Hub's own colours are held to the
  same check, which is why they are listed above with their ratios.

## Typography

- **Inter** only, weights 400/500/600/700/800 — all five self-hosted from `/vendor/inter`
  and all five actually downloaded. A weight a stylesheet sets but the page never loads is
  a faux bold, which is what every h1 in the reference was until somebody checked it in a
  real browser. That bug is fixed here before the first heading ships, not after.
- Headings are navy, 700 (h1 is 800), `letter-spacing: -0.02em`.
- Desktop scale: h1 `clamp(2rem, 5vw, 3rem)`, h2 `clamp(1.75rem, 4vw, 2.5rem)`,
  h3 `clamp(1.5rem, 3vw, 1.875rem)`, h4 `1.5rem`, h5 `1.25rem`, h6 `1rem`.
- Mobile (≤767.98px) steps the scale down **in full** — h1 1.875rem through h6 0.875rem.
  If you override one heading level in a media query, override them all, or the hierarchy
  inverts at some width.
- No interactive text below 12px.
- **Module codes are not shouting.** `FI`, `MM`, `EWM` and the rest are set in the body
  face at body weight. Rendering them in a mono face or in caps-with-tracking, as a
  technical UI reflexively does, turns half of this product's vocabulary into decoration.

## Page anatomy

- **Landing pages** (home) open with the full `.hero`.
- **Every other page** opens with the `partials/page-header` band:
  ```ejs
  <%- include('../partials/page-header', {
        heading: 'Your jobs',                  // required
        sub: 'Publish, pause and close roles', // optional, escaped
        icon: 'bi-briefcase',                  // optional
        label: 'HIRING'                        // optional eyebrow, renders a .section-badge
      }) %>
  ```
  Nothing else goes in the header. A shared component that grows a slot for arbitrary
  markup stops being shared.
- Content sections use `.section-padding` inside a `.container`.
- Never greet someone with their raw email — `User.buildSessionUser` already falls back to
  the local part for the display name, and that is as far as it should ever go.

## Where the wash goes

Glass only reads as glass when there is colour behind it. A frosted card on a plain white
page is just a white card, and a permanent full-page wash greys the whole app.

So the body is a clean white base, and the wash is applied deliberately:

- `.wash-section` puts a soft blue/navy radial behind a band of content.
- `.hero` and `.page-header` carry their own gradient and need no wash.
- A `.glass-card` outside a wash is a plain card. That is allowed, but know that is what
  you are getting.

## Components

- `.glass-card` — frosted panel, 16px radius, 1px hairline border, soft shadow. The
  default container for anything list-like.
- `.icon-tile` — gradient square holding one Bootstrap icon. Colour modifiers only from
  the sanctioned `--grad-*` set.
- `.section-badge` — the small upper-case eyebrow above a heading.
- `.stat-tile` — one number and one label. The number is navy 800; the label is
  `--text-light`, never `--text-muted` at body size.
- `.btn-primary` carries `--accent-gradient`; `.btn-outline-primary` is the secondary.
  There is no third button style.
- Empty states are a sentence and an action, never a shrug. A list with nothing in it says
  what would put something there.

## Accessibility floor

- 4.5:1 for anything anybody has to read, measured with `utils/contrast.js`.
- Focus is always visible — a 2px `--primary-blue` ring, never `outline: none`.
- Icons that carry meaning get an `aria-label`; icons beside their own label get
  `aria-hidden="true"`.
- Every form control has a real `<label>`. A placeholder is not a label.
- Touch targets are 44px or larger.

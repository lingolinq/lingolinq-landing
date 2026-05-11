# lingolinq-landing

Marketing landing page for [lingolinq.com](https://lingolinq.com). Static HTML, one Netlify Function, no framework. Brand-aligned with the LingoLinq design system at `~/ai-company-brain/instructions/DESIGN.md`.

## Layout

```
.
├── index.html               # main landing page (Tier 1 / Style A)
├── privacy.html             # GDPR-aware privacy notice
├── assets/
│   ├── styles.css           # all CSS, tokens map to DESIGN.md
│   ├── form.js              # beta signup form handler
│   ├── favicon.svg          # LL icon
│   ├── LL_Line_Bright.png   # header logo
│   ├── LL_Line_Full_Bright.svg
│   └── LL_Stack_Bright.png  # OG / apple-touch
├── netlify/
│   └── functions/
│       └── beta-signup.js   # form endpoint: HubSpot + backup email
├── netlify.toml             # publish, headers, redirects, CSP
├── package.json
├── .env.example
└── .gitignore
```

## Local dev

```bash
nvm use 20
npx netlify-cli dev   # serves index.html + functions on :8888
```

You'll need `netlify link` once to associate this repo with the Netlify site.

## Required environment variables

Set these in the Netlify site dashboard (`Site configuration → Environment variables`).
Never put real values in `.env` and never commit `.env`.

| Var | What it is | Where to find it |
|-----|------------|------------------|
| `HUBSPOT_PORTAL_ID` | Numeric portal id | HubSpot account → top right → portal id |
| `HUBSPOT_FORM_GUID` | UUID of the Beta Waitlist form | HubSpot → Marketing → Forms |
| `HUBSPOT_SUBSCRIPTION_TYPE_ID` | Marketing subscription id (optional) | HubSpot → Settings → Marketing → Email → Subscription Types |
| `RESEND_API_KEY` | `re_...` key | resend.com → API Keys |
| `FORWARDER_FROM_EMAIL` | Verified sender on a Resend-verified domain | Suggested: `beta@lingolinq.com` |
| `FORWARDER_TO_EMAIL` | Backup inbox | `info@lingolinq.com` |

If HubSpot vars are missing, the form returns a friendly error. If Resend vars are missing, signups still succeed; the backup email is just skipped.

## Brand compliance

- Tokens map to `~/ai-company-brain/instructions/DESIGN.md`.
- Tier 1 palette: Deep Purple `#22215A` + Periwinkle `#7886F3`.
- Fonts: Lexend headings, Atkinson Hyperlegible body, web fallbacks Nunito Sans + Open Sans.
- One amber callout maximum on the page (the "Why now" section).
- No em dashes in user-facing prose. Em dashes are allowed in this file (technical doc).
- WCAG 2.1 AA targeted. 44px minimum tap targets. Alt text on every image.

## Branching

Same convention as the AAC repo:
- `<type>/scot-<description>` for branches Scot owns.
- This site has no `staging` branch; PRs target `main` and Netlify previews each PR.

## Workflow

1. Create or check out a branch.
2. Edit. `npx netlify-cli dev` previews locally.
3. Push and open a PR.
4. Netlify posts a deploy preview URL on the PR.
5. Run `/adversary-review` on the diff before merge.
6. Merge to `main`. Netlify deploys to production automatically.

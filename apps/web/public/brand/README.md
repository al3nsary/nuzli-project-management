# Brand assets — real logos, never redrawn

Source: the owner's Muhsen app (`Desktop/Muhesn-App/app/assets/images.json` and `Muhesn-App/deploy/`), extracted byte-for-byte on 2026-10-12 (owner request A7).

Since owner request A9 (2026-10-19) **Nozoly is the identity** (white + Nozoly indigo `#303F9F`); the Muhsen mark is secondary («منظومة مُحسن» in footers). See `docs/branding.md`.

| File | What | Use (A9) |
|---|---|---|
| `nozoly-green.png` | Nozoly / نُزلي wordmark + mark, green | **the logo** on white: sidebar head, auth card, boot loader, PWA icons |
| `nozoly-light.png` | Nozoly wordmark, light/silver | the same places in dark mode |
| `muhsen-mark.png` | Muhsen "M", black + gold | «منظومة مُحسن» line on light surfaces; print cards default logo |
| `muhsen-mark-white.png` | Muhsen "M", white + gold | «منظومة مُحسن» line in dark mode |
| `muhsen-lockup-white.png` | MUHSEN / مُحسن lockup, white + gold | not used since A9 |
| `muhsen-pattern.png` | Muhsen geometric pattern | not used since A9 |
| `muhsen-app-icon-*.png` | Muhsen app icon (green, M, pattern) | reference only |

`nozoly-*.png` are 540×156 with transparent margins: the artwork is at x 14–415, y 44–141 and the mark alone at x 14–169. The UI places the file in a box sized to the artwork (`NozolyLogo` in `src/components/Brand.tsx`); the files themselves are never edited.

Do not recolour, stretch, crop into, or redraw these files.

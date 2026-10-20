# Brand assets — the Nozoly logo

Source: the owner's own Nozoly artwork. On 2026-10-19 (owner request A11, approved) it was **recoloured once** to Nozoly violet `#5030E5` (the alpha channel is kept). Nothing else is changed: no redrawing, stretching or cropping. See `docs/branding.md`.

Nozoly is the only brand of the system. There are no Muhsen files (all deleted on approval of A11).

| File | What | Use |
|---|---|---|
| `nozoly.png` | Nozoly / نُزلي wordmark + mark, violet `#5030E5` | **the logo** on white: sidebar head, auth card, boot loader, PWA icons |
| `nozoly-light.png` | Nozoly wordmark, light | the same places in dark mode |

`nozoly*.png` are 540×156 with transparent margins: the artwork is at x 14–415, y 44–141 and the mark alone at x 14–169. The UI places the file in a box sized to the artwork (`NozolyLogo` in `src/components/Brand.tsx`, accessible name «شعار نُزلي»).

If the colour must change again, recolour the owner's original artwork once and replace both files; do not edit these by hand.

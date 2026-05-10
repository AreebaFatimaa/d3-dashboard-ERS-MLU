# Concurrent change in U.S. land use, 1945–2017

A D3.js dashboard that visualizes the rise of **defense & industrial** land
alongside the concurrent change in **forest**, **cropland**, or **grassland** across
the 48 contiguous U.S. states from 1945 to 2017.

> **Concurrent change, not direct conversion.** The data records *stocks* of each
> land category at each survey year. It does not say that any acreage of forest
> "became" defense. The dashboard shows what changed *at the same time* in the same
> state — read causality at your own peril.

## What the dashboard shows

- **Forty-eight state slides** in a carousel, alphabetical by state name, with
  prev / next buttons, a clickable dot strip, and ← / → keyboard arrows.
- **Two stacked U.S. maps per slide.** The top map is fixed to *defense &
  industrial* land. The bottom map shows your choice of *forest-use*, *cropland
  used for crops*, or *grassland pasture & range*.
- **Three interchangeable map types** controlled from the panel:
  - **Spike map** — vertical spikes at each state centroid, height proportional to
    acreage; spike width and shape (line, triangle, lollipop) are tunable.
  - **Bubble cartogram** — one circle per state at the state centroid, radius
    proportional to acreage.
  - **Choropleth** — state polygons colored by acreage, with optional pattern fills
    (stripes, dots, hatch) for accessibility.
- **Active state glow.** The current carousel state is wrapped in a soft drop-shadow
  halo whose color you choose in the highlight picker.
- **Per-state time-series small-multiples** beneath the maps. Two stacked tiny line
  charts show the focused state's defense-and-industrial acreage and the chosen
  bottom-metric acreage across all 16 ERS survey years. The current year is marked
  with a vertical guide and a gold dot, with the value rendered top-right.
- **Time controls.** A year slider that snaps to the 16 ERS years (1945, 1949, 1954,
  1959, 1964, 1969, 1974, 1978, 1982, 1987, 1992, 1997, 2002, 2007, 2012, 2017),
  plus play / pause, 0.5× / 1× / 2× speed, and a two-handle range clamp.
- **Color & opacity controls** — three palette presets per layer, a custom color
  picker per layer, per-layer opacity, and a configurable highlight color.
- **Scale controls** — linear, square-root, or log scale (log clamps the domain to
  `[1, max]`); per-year vs. global domain.
- **Tooltip** on hover shows both metrics in acres and the change since 1945 for
  the hovered state.
- **Per-card export.** Each map card has *SVG* and *PNG* download buttons in its
  top-right corner. A slide-level *Export combined* button stacks both maps and
  both time-series strips into a single graphic. Exports inline computed CSS, embed
  `<title>` and `<desc>` for accessibility, and rasterize at 2× DPI for retina-sharp
  PNGs. Map titles, state name, year, and current viz settings are baked into the
  exported file so it stands alone outside the dashboard.

## Data

USDA Economic Research Service, *Major Land Uses* (release dated 2024-09-13). The
prepared CSV at `data/ers_mlu_state_year_48_states_wide.csv` covers 16 ERS survey
years × 48 contiguous states.

## Run locally

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000/>. (Browsers block `fetch()` from `file://`, so the
dashboard needs to be served over HTTP.)

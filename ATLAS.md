# Atlas — four visualisations of the same gap

The Atlas tab in the studio renders four different visualisations of the
exact same data — the same two packs, side-by-side. Each one makes a
different argument; each one suits a different audience.

This is deliberate. A roadmap that needs sign-off rarely fails because the
data is wrong. It fails because the right data wasn't shown to the right
person in the right form. The Atlas exists so the same JSON can speak to
engineers, architects, programme managers, and the board.

---

## Stratigraphy — *the cutaway*

> Inspired by 19th-century geological cross-sections (Cuvier 1812, Lyell
> 1830, USGS strata columns).

Two columns: present state on the left, target on the right. Each layer
is drawn as a horizontal band. Voids in the left band are gaps. The right
band is a clean parallelogram — what the layer *would* look like if
intact.

**The argument:** "We have *eroded* layers."

**What lands:** the visceral asymmetry of the silhouette. The L5
Validation band is barely there; the L4 Action band has three deep
notches. You feel the dysfunction before you read a number.

**Audience:** engineering leadership in a war-room conversation. Visceral.

**Why it works:** the geological metaphor gives the listener a hundred
years of intuition for free. Erosion = something is missing; sedimentary
gaps = unconformities; the strata diagram has been taught in earth
science since Hutton. You don't have to explain the metaphor.

---

## Periodic Table — *every cell that should exist*

> Inspired by Mendeleev's 1869 periodic table.

A grid. Rows are layers (L1, L2, L3, L4, L5, GOV). Columns are artefacts
within each layer. Filled cells = present. Dashed empty cells = predicted
gaps. Cells with `★` = added in the target.

**The argument:** "Every artefact that should exist gets a cell. Half are
empty."

**What lands:** the analytical completeness. You can audit a row in 10
seconds and say "L5 has 5 slots, 1 is filled". Mendeleev's table was
famous *because* it left holes where elements weren't yet discovered —
gallium and germanium were predicted from the gaps before being found. The
same epistemic move applies here: the gap *itself* is a thesis.

**Audience:** architects and SREs. Analytical. They will read every cell.

**Why it works:** the periodic-table layout invites comparison-by-row and
comparison-by-column. A row is a layer; a column-position is a
canonical-ordering. You can spot the missing cell from across the room.

---

## Constellation — *the night sky of the platform*

> Inspired by Cellarius's *Harmonia Macrocosmica* (1660) and Hevelius's
> *Firmamentum Sobiescianum* (1690).

A dark navy sky. Five wedge-shaped sectors radiate from a central compass,
one per layer. Each artefact is a star. Brightness encodes source: BAU
and OLA stars sparkle; NEW stars pulse; GAP stars are dashed ghost
outlines. A slider at the bottom morphs the current sky into the target
sky — gaps light up as you drag.

**The argument:** "Half the stars are dark. Drag the slider — that's what
the sky looks like when the project is done."

**What lands:** the emotional register. You don't read this view, you
*see* it. The transformation from dim sky to fully-lit sky is visceral in
a way no bar chart is.

**Audience:** exec, board, and any room where the question is "should we
fund this?". Emotional, memorable, presentation-ready.

**Why it works:** celestial cartography has always carried the cultural
weight of "the whole picture you should care about". When half the picture
is dark, *that itself is the argument*. The Cellarius reference is also a
discreet signal that someone has thought carefully about how to
communicate this — it's not just another dashboard.

---

## Skyline — *the project plan written in geometry*

> Inspired by Tufte's slopegraphs (*The Visual Display of Quantitative
> Information*, 1983) and the silhouette of a city skyline at dusk.

A slopegraph. One line per layer. Left endpoint = current coverage %.
Right endpoint = target coverage %. The steepest line is the biggest
delta.

**The argument:** "L5 is +80%. Governance is +67%. L4 is +30%. That's not
a wish-list, it's prioritisation."

**What lands:** the quantified gap, sorted by leverage. The flat line at
the top (a layer at 100%) is the layer you don't need to talk about. The
near-vertical line at the bottom is the layer the project lives or dies
on.

**Audience:** programme managers, portfolio reviewers, finance. Anyone
whose job is to allocate the next dollar.

**Why it works:** Tufte's slopegraph rewards comparison along *change*,
not absolute level. The eye picks up the steepest slope automatically.
You don't need to ask "what's the biggest gap" — the geometry tells you.

---

## When to use which

If you have ten seconds in a hallway: **Stratigraphy.** One image, one
take-away.

If you're answering "what specifically is missing?": **Periodic Table.**
Drill in by cell.

If you're presenting to a non-technical audience: **Constellation.** The
slider does the work for you.

If you're writing the project plan: **Skyline.** The slopes are the line
items.

---

## What they share

All four visualisations:
- Read the same two packs (A → B from the dropdowns).
- Round-trip clicks to the drawer — every notch / cell / star / line label
  opens the artefact's detail panel.
- Re-render automatically when packs are loaded or refreshed.
- Render entirely client-side as SVG. No images, no canvas fallback.
- Print cleanly (the studio ships with a print stylesheet).

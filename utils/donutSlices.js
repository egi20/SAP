'use strict';

/**
 * Counts -> donut slices, for the "by country" breakdowns on the Sales agents tab (ported
 * from dynamicshub.net, so the two admin screens read the same way).
 *
 * The chart is plain inline SVG: one <circle> per slice with `pathLength="100"`, so a
 * slice's dasharray is simply its PERCENTAGE and the offset is the running total — no
 * canvas, no charting library, nothing from a CDN the CSP would have to allow.
 *
 * Two rules it exists to keep, both of which read as bugs when broken:
 *   - the slices always add up to 100%: a long tail folds into ONE "Other" slice rather than
 *     being dropped, so the ring and the total printed in it agree;
 *   - a bucket with no count never becomes a slice.
 *
 * The colours live here and not in style.css: they are SVG attributes on the slices, and the
 * palette test keeps hard-coded hex out of the stylesheet. They are the site's own navy and
 * blue ramp, not a rainbow.
 */
const PALETTE = Object.freeze(['#00265b', '#0064d9', '#0a4c9b', '#7ac5ff', '#35b0d3', '#5b6abf', '#5a6673']);
const OTHER_COLOR = '#c8d1dc';

function donutSlices(rows, { top = 6, otherLabel = 'Other' } = {}) {
  const clean = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      label: r && r.label != null ? String(r.label) : '',
      key: r && r.key != null ? String(r.key) : null,
      count: Number(r && r.count) || 0
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));

  const total = clean.reduce((n, r) => n + r.count, 0);
  if (!total) return { slices: [], total: 0, distinct: 0, hasData: false };

  const limit = Math.max(1, parseInt(top, 10) || 6);
  const head = clean.slice(0, limit);
  const tail = clean.slice(limit);
  if (tail.length) {
    head.push({ label: otherLabel, key: null, count: tail.reduce((n, r) => n + r.count, 0), isOther: true, members: tail });
  }

  let offset = 0;
  const slices = head.map((r, i) => {
    // Unrounded for the geometry (rounding each slice on its own leaves a hairline gap),
    // rounded only for the label.
    const pct = (r.count / total) * 100;
    const slice = {
      label: r.label,
      key: r.key,
      count: r.count,
      pct,
      display: pct >= 1 ? Math.round(pct) : Math.round(pct * 10) / 10,
      dash: pct,
      gap: 100 - pct,
      offset: -offset,
      color: r.isOther ? OTHER_COLOR : PALETTE[i % PALETTE.length],
      isOther: !!r.isOther,
      members: r.members || null
    };
    offset += pct;
    return slice;
  });

  return { slices, total, distinct: clean.length, hasData: true };
}

module.exports = { donutSlices, PALETTE, OTHER_COLOR };

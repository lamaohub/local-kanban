
const SVG_NS = 'http://www.w3.org/2000/svg';
const CLIP = 'link-clip';

const ARC_PX = 80; // a line leaves the bottoms of its cards by at most this much (the bow of the arc in drawLinks)

/** Whether a line between cards `a` and `b` (their rects) cannot show in the board `box`: both are past the same edge. Such
    a line is not drawn at all: a long column holds most of the lines of a board out of sight, and each costs a repaint. */
export function lineOutOfSight(a, b, box) {
  return (a.bottom + ARC_PX < box.top && b.bottom + ARC_PX < box.top) || (a.top > box.bottom && b.top > box.bottom);
}

/** Bring the layer `svg` to `lines` — [[pair, d]] — clipped to `clip` {y, width, height}. `pair` is what keeps a path across
    frames. Writes only what differs from what the layer holds. */
export function writeLines(svg, lines, clip) {
  const drawn = svg._kbDrawn || (svg._kbDrawn = { rect: null, group: null, clip: '', paths: new Map() });
  if (!lines.length) {
    if (drawn.group) { svg.innerHTML = ''; drawn.rect = null; drawn.group = null; drawn.clip = ''; drawn.paths.clear(); }
    return;
  }
  if (!drawn.group) {
    svg.innerHTML = `<clipPath id="${CLIP}"><rect x="0"/></clipPath><g clip-path="url(#${CLIP})"></g>`;
    drawn.rect = svg.querySelector('rect');
    drawn.group = svg.querySelector('g');
  }
  const box = `${clip.y} ${clip.width} ${clip.height}`;
  if (drawn.clip !== box) {
    drawn.clip = box;
    drawn.rect.setAttribute('y', clip.y);
    drawn.rect.setAttribute('width', clip.width);
    drawn.rect.setAttribute('height', clip.height);
  }
  const live = new Set();
  for (const [pair, d] of lines) {
    live.add(pair);
    let path = drawn.paths.get(pair);
    if (!path) {
      path = { el: svg.ownerDocument.createElementNS(SVG_NS, 'path'), d: null };
      path.el.setAttribute('class', 'link-line');
      drawn.group.appendChild(path.el);
      drawn.paths.set(pair, path);
    }
    if (path.d !== d) { path.d = d; path.el.setAttribute('d', d); }
  }
  for (const [pair, path] of drawn.paths) {
    if (!live.has(pair)) { path.el.remove(); drawn.paths.delete(pair); }
  }
}

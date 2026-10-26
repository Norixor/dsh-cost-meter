// A <button> that renders exactly like the surrounding text.
const plainButton = { appearance: 'none', background: 'none', border: 0, padding: 0, margin: 0, fontFamily: 'inherit', textAlign: 'left' }

function dot(color, size = 7) {
  return h('span', { style: { width: size, height: size, borderRadius: '50%', background: color, flex: '0 0 auto' } })
}

const ICON_PATHS = {
  session: 'M2.5 3.5h11v6.2h-5.2L5 12.3v-2.6H2.5z',
  models: 'M8 1.8 13.8 5v6L8 14.2 2.2 11V5z M2.2 5 8 8.2 13.8 5 M8 8.2v6',
  // Bar chart on a baseline: the sidebar entry glyph (the page is statistics only).
  panel: 'M2.5 13.5h11 M4.7 13.5V8.2 M8 13.5V2.8 M11.3 13.5V5.8',
  refresh: 'M13.2 8A5.2 5.2 0 1 1 11.6 4.3 M13.4 2.6v3.2h-3.2',
  chevron: 'M4 6.2 8 10l4-3.8',
}

function uiIcon(kind, size = 14, spin = false) {
  const d = ICON_PATHS[kind] || ICON_PATHS.models
  return h('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    'aria-hidden': true,
    style: { flex: '0 0 auto', display: 'inline-block' },
  }, h('g', null,
    spin ? h('animateTransform', { attributeName: 'transform', type: 'rotate', from: '0 8 8', to: '360 8 8', dur: '0.8s', repeatCount: 'indefinite' }) : null,
    h('path', {
      d,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })))
}

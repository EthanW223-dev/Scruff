// Telos's icons: square-capped, mitred 2px strokes on a 24px grid, so they sit with the
// retro window chrome (square corners, hard shadows). Inline SVG in currentColor, offline.
//   <i data-icon="chat"></i>   →  hydrateIcons(document) fills it in.

const PATHS = {
  chat: '<path d="M3 4h18v12H10l-5 4v-4H3z"/><path d="M8 10h0M12 10h0M16 10h0"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><path d="M15 4v4M9 10v4M17 16v4"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v5h5"/><path d="M12 7v5l3 3"/>',
  game: '<path d="M7 8h10a5 5 0 0 1 5 5v2a3 3 0 0 1-5.4 1.8L15 15H9l-1.6 1.8A3 3 0 0 1 2 15v-2a5 5 0 0 1 5-5z"/><path d="M7 10v4M5 12h4"/><path d="M16 11h0M18 13h0"/>',
  folder: '<path d="M3 5h7l2 2h9v12H3z"/>',
  plug: '<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  link: '<path d="M10 14l4-4"/><path d="M8.5 11.5l-3 3a3 3 0 0 0 4.2 4.2l3-3"/><path d="M15.5 12.5l3-3a3 3 0 0 0-4.2-4.2l-3 3"/>',
  chip: '<path d="M6 6h12v12H6z"/><path d="M10 10h4v4h-4z"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  screen: '<path d="M3 4h18v12H3z"/><path d="M8 20h8M12 16v4"/>',
  mic: '<path d="M9 3h6v10H9z"/><path d="M5 11v1a7 7 0 0 0 14 0v-1"/><path d="M12 19v3"/>',
  send: '<path d="M4 12h15"/><path d="M13 6l6 6-6 6"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  lock: '<path d="M5 11h14v10H5z"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<path d="M5 11h14v10H5z"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  undo: '<path d="M9 15L4 10l5-5"/><path d="M4 10h11a5 5 0 0 1 0 10h-3"/>',
  spark: '<path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><path d="M12 8l4 4-4 4-4-4z"/>',
  bolt: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h0"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  pin: '<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/>',
};

export const ICONS = Object.keys(PATHS);

/** The SVG markup for an icon (empty for unknown names). */
export function iconSvg(name, size = 16) {
  const paths = PATHS[name];
  if (!paths) return "";
  return (
    `<svg class="ico-svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">${paths}</svg>`
  );
}

/** An <i class="ico"> element holding the icon, for building UI in code. */
export function icon(name, size = 16) {
  const i = document.createElement("i");
  i.className = "ico";
  i.dataset.icon = name;
  i.innerHTML = iconSvg(name, size);
  return i;
}

/** Fills every <i data-icon="…"> under root that isn't filled yet. */
export function hydrateIcons(root = document) {
  for (const i of root.querySelectorAll("i[data-icon]:empty")) {
    i.classList.add("ico");
    i.innerHTML = iconSvg(i.dataset.icon, Number(i.dataset.size) || 16);
  }
}

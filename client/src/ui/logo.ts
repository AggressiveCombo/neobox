// The neobox mark: a blue gradient square tilted -30 degrees on a black tile.
// Mirrors client/public/logo.svg; the gradient id is unique per instance so
// several inline logos can share a document.

const SVG_NS = "http://www.w3.org/2000/svg";

let counter = 0;

export function logoSvg(sizePx: number): SVGSVGElement {
  counter += 1;
  const gradId = `neobox-logo-grad-${counter}`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", String(sizePx));
  svg.setAttribute("height", String(sizePx));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const defs = document.createElementNS(SVG_NS, "defs");
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.setAttribute("id", gradId);
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "1");
  grad.setAttribute("y2", "1");
  grad.appendChild(stop("0", "#0095ff"));
  grad.appendChild(stop("1", "#0080ff"));
  defs.appendChild(grad);

  const tile = document.createElementNS(SVG_NS, "rect");
  tile.setAttribute("width", "64");
  tile.setAttribute("height", "64");
  tile.setAttribute("rx", "12");
  tile.setAttribute("fill", "#000000");

  const mark = document.createElementNS(SVG_NS, "rect");
  mark.setAttribute("x", "18");
  mark.setAttribute("y", "18");
  mark.setAttribute("width", "28");
  mark.setAttribute("height", "28");
  mark.setAttribute("rx", "4");
  mark.setAttribute("fill", `url(#${gradId})`);
  mark.setAttribute("transform", "rotate(-30 32 32)");

  svg.append(defs, tile, mark);
  return svg;
}

function stop(offset: string, color: string): SVGStopElement {
  const el = document.createElementNS(SVG_NS, "stop");
  el.setAttribute("offset", offset);
  el.setAttribute("stop-color", color);
  return el;
}

// The neobox logo is the project's own file, public/logo.svg (served next to
// index.html); every use loads that file so there is a single source of truth.

export const LOGO_URL = "logo.svg";

/** The logo as an image. Decorative: the wordmark beside it names the app. */
export function logoImg(sizePx: number): HTMLImageElement {
  const img = document.createElement("img");
  img.src = LOGO_URL;
  img.width = sizePx;
  img.height = sizePx;
  img.alt = "";
  img.decoding = "async";
  return img;
}

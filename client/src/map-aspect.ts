// A map's view aspect (docs/CLIENT-API.md "Camera"): the original's 16:10 view, or the widescreen 16:9 that Neobox maps can choose.
// The sim decides it per map (MapSettings.wide, the settings key "aspect" = "wide"); the frame carries it (header word 42).

/** The original's view: 35 x 21.875 world units arena, 16:10. */
export const CLASSIC_ASPECT = 1.6;
/** The widescreen view: 16:9. */
export const WIDE_ASPECT = 16 / 9;

/** The aspect for a map's `wide` flag. */
export function aspectFor(wide: boolean): number {
  return wide ? WIDE_ASPECT : CLASSIC_ASPECT;
}

/** The map setting value for a `wide` flag: `"wide"`, or `"classic"` (the original's default). */
export function aspectSetting(wide: boolean): "classic" | "wide" {
  return wide ? "wide" : "classic";
}

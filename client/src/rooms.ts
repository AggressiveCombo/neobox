// Room list helpers: distance text, sort order and country names. Pure: no DOM, no store.

import type { RoomInfo } from "./protocol";

/** Viewers in these countries read distances in miles. */
const MILES_COUNTRIES: Record<string, true> = { GB: true, US: true };
const KM_PER_MILE = 1.609344;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Distance text for a room row: miles for GB and US viewers, km elsewhere; "—" when unknown. */
export function formatDistance(km: number | null, viewerCountry: string | null): string {
  if (km === null) return "—";
  if (viewerCountry !== null && MILES_COUNTRIES[viewerCountry.toUpperCase()] === true) {
    return `${Math.round(km / KM_PER_MILE)} mi`;
  }
  return `${Math.round(km)} km`;
}

/** Friends' rooms first, then nearest first with unknown distances last. Equal rooms keep the server's order. */
export function sortRooms(rooms: readonly RoomInfo[]): RoomInfo[] {
  return [...rooms].sort((a, b) => {
    const friends = Number(b.friends.length > 0) - Number(a.friends.length > 0);
    if (friends !== 0) return friends;
    const da = a.distance ?? Number.POSITIVE_INFINITY;
    const db = b.distance ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da < db ? -1 : 1;
    return 0;
  });
}

/** Flag image of an ISO country code (flag-icons 4x3 SVGs in public/flags). */
export function flagUrl(country: string): string {
  return `/flags/${country.toLowerCase()}.svg`;
}

/** English name of an ISO country code; the code itself when the platform does not know it. */
export function countryName(country: string): string {
  try {
    return regionNames.of(country.toUpperCase()) ?? country;
  } catch {
    return country;
  }
}

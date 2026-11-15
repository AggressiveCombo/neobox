// Run: bun test client/src/rooms.test.ts
import { expect, test } from "bun:test";
import type { RoomInfo } from "./protocol";
import { countryName, flagUrl, formatDistance, sortRooms } from "./rooms";

function room(code: string, distance: number | null, friends: string[] = []): RoomInfo {
  return {
    code,
    name: code,
    players: 0,
    max_players: 8,
    password: false,
    in_match: false,
    map: "",
    mode: 0,
    quick: null,
    jukebox: null,
    friends,
    region: "",
    distance,
    country: null,
  };
}

test("distance is km, or miles for GB and US viewers", () => {
  expect(formatDistance(100, "DE")).toBe("100 km");
  expect(formatDistance(100, "US")).toBe("62 mi");
  expect(formatDistance(100, "gb")).toBe("62 mi");
  expect(formatDistance(100, null)).toBe("100 km");
  expect(formatDistance(null, "US")).toBe("—");
});

test("friends first, then nearest, unknown last, ties keep the server's order", () => {
  const sorted = sortRooms([
    room("far", 900),
    room("none", null),
    room("near", 10),
    room("pal", 500, ["ann"]),
    room("tie", 10),
  ]);
  expect(sorted.map((r) => r.code)).toEqual(["pal", "near", "tie", "far", "none"]);
});

test("flag path and country names", () => {
  expect(flagUrl("DE")).toBe("flags/de.svg");
  expect(countryName("DE")).toBe("Germany");
  expect(countryName("GB")).toBe("United Kingdom");
});

// Run: bun test client/src/profanity.test.ts
import { expect, test } from "bun:test";
import { filterProfanity } from "./profanity";

test("masks listed words, keeping the length", () => {
  expect(filterProfanity("that is shit")).toBe("that is ****");
  expect(filterProfanity("shit").length).toBe(4);
  expect(filterProfanity("SHIT happens")).toBe("**** happens");
  expect(filterProfanity("what the fuck.")).toBe("what the ****.");
  expect(filterProfanity("shit, ok")).toBe("****, ok");
});

test("matches leetspeak, accents and symbols", () => {
  expect(filterProfanity("sh1t")).toBe("****");
  expect(filterProfanity("a$$")).toBe("***");
  expect(filterProfanity("@ss")).toBe("***");
  expect(filterProfanity("c0ck")).toBe("****");
  expect(filterProfanity("f\u00fcck")).toBe("****");
  expect(filterProfanity("sh\u0327it")).toBe("*****");
});

test("masks multi-word phrases only when the words are adjacent", () => {
  expect(filterProfanity("a big black dog")).toBe("a ********* dog");
  expect(filterProfanity("blow job")).toBe("********");
  expect(filterProfanity("big, black dog")).toBe("big, black dog");
});

test("leaves normal words alone (no substring matches)", () => {
  expect(filterProfanity("assistant")).toBe("assistant");
  expect(filterProfanity("classic")).toBe("classic");
  expect(filterProfanity("Scunthorpe")).toBe("Scunthorpe");
  expect(filterProfanity("bass butter titanic class")).toBe("bass butter titanic class");
  expect(filterProfanity("hello world")).toBe("hello world");
  expect(filterProfanity("")).toBe("");
});

test("skips links", () => {
  expect(filterProfanity("https://example.com/shit")).toBe("https://example.com/shit");
  expect(filterProfanity("www.example.com shit")).toBe("www.example.com ****");
  expect(filterProfanity("see youtu.be/dQw4w9WgXcQ")).toBe("see youtu.be/dQw4w9WgXcQ");
});

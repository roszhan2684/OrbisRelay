import { describe, expect, it } from "vitest";
import urlFixtures from "../__fixtures__/url-parity.json";
import msgFixtures from "../__fixtures__/message-parity.json";
import { scoreHost, scoreMessage, tokenize } from "../models";
import { normalizeHost } from "../url-features";

describe("python ↔ typescript parity", () => {
  it.each(urlFixtures as Array<{ url: string; host: string; p: number }>)("url $url", ({ url, host, p }) => {
    expect(normalizeHost(url)).toBe(host);
    expect(scoreHost(url).probability).toBeCloseTo(p, 6);
  });
  it.each(msgFixtures as Array<{ text: string; tokens: string[]; p: number }>)("message %#", ({ text, tokens, p }) => {
    expect(tokenize(text)).toEqual(tokens);
    expect(scoreMessage(text).probability).toBeCloseTo(p, 6);
  });
});

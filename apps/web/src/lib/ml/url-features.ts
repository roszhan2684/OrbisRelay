// 1:1 port of ml/phishing_url/features.py. Parity-tested against __fixtures__/url-parity.json.

export const FREE_HOSTING = [
  "web.app", "firebaseapp.com", "weeblysite.com", "weebly.com", "repl.co", "glitch.me",
  "000webhostapp.com", "github.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "wixsite.com", "blogspot.com", "herokuapp.com", "azurewebsites.net", "myqcloud.com",
  "ipfs.io", "duckdns.org", "ngrok.io", "ngrok-free.app", "square.site", "webflow.io",
  "sites.google.com", "framer.app", "godaddysites.com", "mybluehost.me", "r2.dev",
];
export const BRANDS = [
  "paypal", "apple", "icloud", "microsoft", "office365", "outlook", "google", "amazon",
  "netflix", "facebook", "instagram", "whatsapp", "chase", "wellsfargo", "bankofamerica",
  "coinbase", "binance", "metamask", "dhl", "fedex", "usps", "docusign", "dropbox", "adobe",
  "linkedin", "okta", "steam", "att", "aol", "yahoo",
];
export const KEYWORDS = [
  "login", "signin", "secure", "verify", "account", "update", "wallet", "support",
  "auth", "bank", "confirm", "billing", "unlock", "recover", "webmail", "service",
];

const IP = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;
const VOWELS = new Set("aeiou");
const isDigit = (c: string) => c >= "0" && c <= "9" && c.length === 1;
const isLetter = (c: string) => c.length === 1 && c >= "a" && c <= "z";

export function normalizeHost(url: string): string {
  let u = url.trim().toLowerCase();
  if (!u.includes("://")) u = "http://" + u;
  const rest = u.split("://").slice(1).join("://");
  let host = rest.split(/[/?#]/, 1)[0];
  if (host.includes("@")) host = host.slice(host.lastIndexOf("@") + 1);
  host = host.split(":")[0].replace(/^\.+|\.+$/g, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host;
}

const encoder = new TextEncoder();
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function runs(chars: string[], pred: (c: string) => boolean) {
  let best = 0;
  let cur = 0;
  for (const c of chars) {
    if (pred(c)) {
      cur += 1;
      if (cur > best) best = cur;
    } else cur = 0;
  }
  return best;
}

export function denseFeatures(host: string): number[] {
  const chars = Array.from(host);
  const labels = host ? host.split(".") : [""];
  const n = Math.max(chars.length, 1);
  const letters = chars.filter(isLetter);
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  if (host) for (const v of counts.values()) entropy -= (v / n) * Math.log2(v / n);
  const tld = labels.length > 1 ? labels[labels.length - 1] : "";
  const sld = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  const free = FREE_HOSTING.some((f) => host === f || host.endsWith("." + f)) ? 1 : 0;
  let brand = 0;
  for (const b of BRANDS) {
    if (host.includes(b) && sld !== b) {
      brand = 1;
      break;
    }
  }
  const kw = KEYWORDS.some((k) => host.includes(k)) ? 1 : 0;
  return [
    chars.length / 30,
    (host.match(/\./g) ?? []).length,
    chars.filter(isDigit).length / n,
    (host.match(/-/g) ?? []).length,
    IP.test(host) ? 1 : 0,
    entropy / 4,
    Math.max(...labels.map((l) => Array.from(l).length)) / 20,
    host.includes("xn--") ? 1 : 0,
    letters.length ? letters.filter((c) => VOWELS.has(c)).length / letters.length : 0,
    runs(chars, isDigit) / 10,
    runs(chars, (c) => isLetter(c) && !VOWELS.has(c)) / 10,
    free,
    brand,
    kw,
    Array.from(tld).length / 10,
    Array.from(sld).length / 20,
  ];
}

export function sparseIndices(host: string, buckets: number, ngrams: number[]): number[] {
  const padded = Array.from("^" + host + "$");
  const idx = new Set<number>();
  for (const n of ngrams) {
    for (let i = 0; i + n <= padded.length; i++) idx.add(fnv1a(padded.slice(i, i + n).join("")) % buckets);
  }
  const labels = host.split(".");
  if (labels.length > 1) idx.add(fnv1a("tld=" + labels[labels.length - 1]) % buckets);
  return [...idx].sort((a, b) => a - b);
}

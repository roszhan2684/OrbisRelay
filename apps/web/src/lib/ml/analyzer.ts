// Protect / "Is this safe?" analyzer. Fuses the from-scratch models with deterministic,
// explainable cues and tenant policy. The model is advisory; rules and policy explain the verdict.
import type { ProtectAnalysis } from "../domain";
import { messageModel, scoreHost, scoreMessage, urlModel } from "./models";
import { normalizeHost } from "./url-features";

type Reason = ProtectAnalysis["reasons"][number];
export interface AnalysisResult {
  verdict: ProtectAnalysis["verdict"];
  score: number;
  recommendation: string;
  reasons: Reason[];
  model: ProtectAnalysis["model"];
  policy_note?: string;
  extracted_urls?: string[];
}

const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "cutt.ly", "rebrand.ly", "shorturl.at"];
const PATH_BAIT = /(login|signin|verify|password|reset|wallet|unlock|confirm|invoice|payment|mfa|otp|account)/i;

function registrable(host: string) {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const twoPart = /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPart ? -3 : -2).join(".");
}

export function analyzeUrl(raw: string, tenantAllow: string[] = [], tenantBrand = "northstar"): AnalysisResult {
  const input = raw.trim();
  const ml = scoreHost(input);
  const host = ml.host;
  const reasons: Reason[] = [];
  let rules = 0;
  const lower = input.toLowerCase();
  const reg = registrable(host);
  const allowlisted = tenantAllow.some((d) => host === d || host.endsWith("." + d) || reg === d);

  if (!/^https:\/\//i.test(input) && /^http:\/\//i.test(input)) {
    reasons.push({ label: "No TLS", detail: "Link uses plain http; anything typed can be intercepted.", weight: "medium" });
    rules += 8;
  }
  if (/^[0-9.]+$/.test(host)) {
    reasons.push({ label: "Raw IP address", detail: `Destination is ${host}, not a named domain.`, weight: "high" });
    rules += 20;
  }
  const authority = lower.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  if (authority.includes("@")) {
    reasons.push({ label: "Hidden destination", detail: "The text before “@” is ignored by browsers — the real host is after it.", weight: "high" });
    rules += 25;
  }
  if (host.includes("xn--")) {
    reasons.push({ label: "Look-alike characters", detail: "Punycode hostname can imitate a familiar brand with foreign letters.", weight: "high" });
    rules += 20;
  }
  if (SHORTENERS.includes(host)) {
    reasons.push({ label: "Link shortener", detail: "The final destination is hidden behind a redirect.", weight: "medium" });
    rules += 20;
  }
  const path = lower.replace(/^[a-z]+:\/\/[^/]+/, "");
  if (PATH_BAIT.test(path) && !allowlisted) {
    reasons.push({ label: "Credential or payment bait", detail: `Path mentions “${path.match(PATH_BAIT)![0]}”.`, weight: "medium" });
    rules += 10;
  }
  if (host.includes(tenantBrand) && !allowlisted) {
    reasons.push({ label: `Impersonates ${tenantBrand[0].toUpperCase()}${tenantBrand.slice(1)}`, detail: `“${host}” uses the company name but is not a ${tenantBrand} domain.`, weight: "high" });
    rules += 30;
  }
  if (input.length > 140) {
    reasons.push({ label: "Unusually long link", detail: `${input.length} characters — often used to hide the real host.`, weight: "low" });
    rules += 4;
  }

  let score = Math.round(ml.probability * 60 + Math.min(rules, 60));
  if (allowlisted) {
    score = Math.min(score, 12);
    reasons.unshift({ label: "Approved destination", detail: `${reg} is on Northstar's allowlist.`, weight: "positive" });
  } else if (ml.probability < 0.2 && rules === 0) {
    reasons.push({ label: "Looks like an established site", detail: `Hostname resembles known-legitimate sites (model ${Math.round(ml.probability * 100)}%).`, weight: "positive" });
  }
  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 65 ? "dangerous" : score >= 35 ? "caution" : "safe";
  if (verdict !== "safe") {
    // Model explanation: strongest positive lexical contributors.
    const named: Record<string, string> = {
      free_hosting: "Hosted on a free site builder",
      brand_impersonation: "Brand name outside its own domain",
      keyword: "Security keyword in hostname",
      hyphens: "Many hyphens in hostname",
      digit_ratio: "Digit-heavy hostname",
      max_digit_run: "Long digit sequence",
      entropy: "Random-looking hostname",
      labels: "Deep subdomain nesting",
      length: "Long hostname",
    };
    ml.contributions
      .filter((c) => c.contribution > 0.35 && named[c.feature])
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
      .forEach((c) => reasons.push({ label: named[c.feature], detail: `Model feature “${c.feature}” raised the score (+${c.contribution.toFixed(2)} logit).`, weight: "low" }));

  }
  return {
    verdict,
    score,
    recommendation:
      verdict === "dangerous"
        ? "Don't open it or enter credentials. Report it — security will block the domain for everyone."
        : verdict === "caution"
          ? "Open only if you expected it. Navigate to the site yourself instead of using this link."
          : "No strong risk signals. Still never enter your Northstar SSO password outside sso.northstar.cloud.",
    reasons,
    model: [{ name: urlModel.name, version: urlModel.version, probability: round(ml.probability) }],
    policy_note: host.includes("sso") || PATH_BAIT.test(path) ? "Northstar policy: credentials are only ever requested at sso.northstar.cloud." : undefined,
  };
}

const CUES: Array<{ re: RegExp; label: string; detail: string; weight: Reason["weight"]; pts: number }> = [
  { re: /\b(gift ?cards?|itunes|steam cards?|google play cards?)\b/i, label: "Gift-card request", detail: "Gift cards are a classic untraceable payment in impersonation scams.", weight: "high", pts: 30 },
  { re: /\b(wire|bank details|account number|routing|new account|change(d)? (our|the) (bank|payment))\b/i, label: "Payment change", detail: "Requests to move money or change bank details need out-of-band verification.", weight: "high", pts: 25 },
  { re: /\b(password|passcode|one[- ]time code|otp|mfa code|verification code|log ?in|sign ?in|verify your)\b/i, label: "Credential request", detail: "Legitimate teams never ask for passwords or codes by message.", weight: "high", pts: 25 },
  { re: /\b(urgent|immediately|asap|within (24|48) hours|final notice|suspended|right now|today only)\b/i, label: "Manufactured urgency", detail: "Pressure to act fast is designed to skip verification.", weight: "medium", pts: 12 },
  { re: /\b(ceo|cfo|this is your (boss|manager)|i'?m in a meeting|can'?t talk|keep this (between us|confidential)|don'?t tell)\b/i, label: "Executive impersonation / secrecy", detail: "Authority plus secrecy is the signature of business email compromise.", weight: "high", pts: 22 },
  { re: /\b(won|winner|prize|claim|congratulations|free entry)\b/i, label: "Prize bait", detail: "Unexpected winnings are almost always a lure.", weight: "medium", pts: 12 },
];

export function analyzeText(text: string, tenantAllow: string[] = []): AnalysisResult {
  const ml = scoreMessage(text);
  const reasons: Reason[] = [];
  let cues = 0;
  for (const c of CUES) {
    if (c.re.test(text)) {
      reasons.push({ label: c.label, detail: c.detail, weight: c.weight });
      cues += c.pts;
    }
  }
  const urls = Array.from(text.matchAll(/(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|co|io|info|biz|xyz|app|dev|link|ly)(\/[^\s]*)?)/gi)).map((m) => m[0]);
  let urlMax = 0;
  for (const u of urls.slice(0, 3)) {
    const r = analyzeUrl(u, tenantAllow);
    urlMax = Math.max(urlMax, r.score);
    if (r.verdict !== "safe") reasons.push({ label: `Risky link: ${normalizeHost(u)}`, detail: r.reasons[0]?.detail ?? "Link scored as risky.", weight: r.verdict === "dangerous" ? "high" : "medium" });
  }
  if (ml.probability > 0.5 && ml.top_tokens.length) {
    reasons.push({ label: "Matches known scam language", detail: `Model ${Math.round(ml.probability * 100)}% — strongest terms: ${ml.top_tokens.slice(0, 3).map((t) => `“${t.token.replace(/[<>]/g, "")}”`).join(", ")}.`, weight: ml.probability > 0.9 ? "medium" : "low" });
  }
  let score = Math.round(ml.probability * 40 + Math.min(cues, 70) + urlMax * 0.4);
  // The 2011 SMS corpus over-scores short benign notes; the model alone can reach "caution" only when very confident.
  if (cues === 0 && urlMax < 35) score = Math.min(score, 40);
  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 50 ? "dangerous" : score >= 35 ? "caution" : "safe";
  if (verdict === "safe") reasons.push({ label: "No manipulation patterns", detail: "No urgency, credential, payment or impersonation cues found.", weight: "positive" });
  return {
    verdict,
    score,
    recommendation:
      verdict === "dangerous"
        ? "Do not reply, click, or pay. Verify the sender through a known channel and report it to security."
        : verdict === "caution"
          ? "Verify the request with the sender through a channel you already trust before acting."
          : "Looks routine. If it asks for anything unexpected later, check again.",
    reasons,
    model: [{ name: messageModel.name, version: messageModel.version, probability: round(ml.probability) }],
    policy_note: /gift|wire|bank|payment/i.test(text) ? "Northstar policy: payment or bank-detail changes require a callback to a number on file." : undefined,
    extracted_urls: urls.slice(0, 3),
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

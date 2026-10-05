// Inference for the two from-scratch Protect models. Pure functions; weights are JSON files
// produced by ml/phishing_url/train.py and ml/message_scam/train.py.
import urlModelJson from "./url-model.json";
import messageModelJson from "./message-model.json";
import { denseFeatures, normalizeHost, sparseIndices } from "./url-features";

interface UrlModel {
  name: string;
  version: string;
  hash_buckets: number;
  ngrams: number[];
  dense_names: string[];
  mean: number[];
  std: number[];
  w_dense: number[];
  w_sparse: number[];
  bias: number;
  threshold: number;
  metrics: { test: Record<string, unknown>; train: Record<string, unknown> };
}
interface MessageModel {
  name: string;
  version: string;
  prior: [number, number];
  loglik: Record<string, [number, number]>;
  indicative: string[];
  metrics: { test: Record<string, unknown>; train: Record<string, unknown> };
}

export const urlModel = urlModelJson as unknown as UrlModel;
export const messageModel = messageModelJson as unknown as MessageModel;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));

export function scoreHost(input: string) {
  const host = normalizeHost(input);
  const dense = denseFeatures(host);
  const contributions = dense.map((v, i) => ({
    feature: urlModel.dense_names[i],
    value: v,
    contribution: ((v - urlModel.mean[i]) / urlModel.std[i]) * urlModel.w_dense[i],
  }));
  let z = urlModel.bias;
  for (const c of contributions) z += c.contribution;
  let sparse = 0;
  for (const i of sparseIndices(host, urlModel.hash_buckets, urlModel.ngrams)) sparse += urlModel.w_sparse[i];
  z += sparse;
  return { host, probability: sigmoid(z), contributions, sparse_contribution: sparse };
}

// Tokenizer mirrors ml/message_scam/train.py
const URL_RE = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|net|org|co|uk|io|ly|me|info|biz|xyz)\b\S*)/g;
const MONEY_RE = /[£$€]\s?\d[\d,.]*|\d[\d,.]*\s?(usd|gbp|eur|pounds|dollars)\b/g;
const PHONE_RE = /\b\d{5,}\b/g;
const NUM_RE = /\b\d+\b/g;
const TOKEN_RE = /[a-z<>_]+|[!?]/g;

export function tokenize(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(URL_RE, " <url> ")
    .replace(MONEY_RE, " <money> ")
    .replace(PHONE_RE, " <phone> ")
    .replace(NUM_RE, " <num> ");
  return (t.match(TOKEN_RE) ?? []).filter((w) => w.length > 1 || w === "!" || w === "?");
}

export function scoreMessage(text: string) {
  const tokens = tokenize(text);
  let [s0, s1] = messageModel.prior;
  const evidence: Array<{ token: string; lr: number }> = [];
  for (const w of tokens) {
    const ll = messageModel.loglik[w];
    if (!ll) continue;
    s0 += ll[0];
    s1 += ll[1];
    evidence.push({ token: w, lr: ll[1] - ll[0] });
  }
  const d = Math.max(-50, Math.min(50, s1 - s0));
  const top = [...new Map(evidence.map((e) => [e.token, e])).values()].sort((a, b) => b.lr - a.lr).slice(0, 5);
  return { probability: 1 / (1 + Math.exp(-d)), tokens, known_tokens: evidence.length, top_tokens: top };
}

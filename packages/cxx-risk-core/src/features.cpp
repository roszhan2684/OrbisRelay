#include "orbis/features.hpp"

#include <algorithm>
#include <cmath>
#include <regex>

namespace orbis {
namespace {

using json::Value;

const std::vector<std::string> kActorTypes = {"human", "agent", "service", "automation"};
const std::vector<std::string> kActionTypes = {"external_send", "file_upload", "clipboard_export", "tool_invoke", "database_query", "privilege_grant", "payment", "refund",
                                               "production_deploy", "secrets_access", "model_provider_send", "bulk_download", "destructive_delete", "config_change", "physical_operation"};
const std::vector<std::string> kClassifications = {"public", "internal", "confidential", "restricted", "regulated", "secret"};
const std::vector<std::string> kDestTypes = {"none", "internal", "internal_model", "approved_vendor", "external_domain", "external_ai_provider", "beneficiary", "external_identity", "partner", "production_env"};
const std::vector<std::string> kDestTrust = {"trusted", "approved", "unverified", "blocked"};
const std::vector<std::string> kPrivilege = {"standard", "elevated", "admin"};
const std::vector<std::string> kPosture = {"managed", "unmanaged"};
const std::vector<std::string> kToolRisk = {"low", "medium", "high"};
const std::vector<std::string> kEnv = {"none", "dev", "staging", "production"};

constexpr int64_t kHour = 3'600'000, kDay = 86'400'000, k5m = 300'000;
constexpr size_t kSeenCap = 4096, kRingCap = 200, kTimesCap = 10'000;
constexpr int64_t kMinBaseline = 5;
constexpr size_t kMinAnomaly = 20;

const std::vector<std::pair<std::string, const std::vector<std::string>*>> kBlocks = {
    {"actor_type", &kActorTypes}, {"action_type", &kActionTypes}, {"classification", &kClassifications}, {"destination_type", &kDestTypes}, {"destination_trust", &kDestTrust},
    {"privilege_level", &kPrivilege}, {"device_posture", &kPosture}, {"tool_risk_class", &kToolRisk}, {"environment", &kEnv}};

const std::vector<std::string> kNumeric = {"resource_log", "amount_log", "off_hours", "weekend", "production_without_window", "has_ticket", "rate_5m", "rate_1h", "rate_ratio", "unique_dest_1h",
                                           "first_destination", "first_tool", "first_action", "resource_z", "baseline_insufficient", "unknown_fields", "class_rank",
                                           "x_sensitive_external", "x_sensitive_untrusted", "x_privileged_new_dest", "x_high_amount_off_hours", "x_destructive_production",
                                           "x_new_tool_elevated", "x_secret_egress", "x_bulk_sensitive"};

bool in(const std::vector<std::string>& v, const std::string& s) { return std::find(v.begin(), v.end(), s) != v.end(); }

std::string enum_of(const Value* v, const std::vector<std::string>& vocab) {
  if (v && v->is_string() && in(vocab, v->s)) return v->s;
  return "unknown";
}

int class_rank(const std::string& c) {
  if (c == "public") return 0;
  if (c == "internal") return 1;
  if (c == "confidential") return 2;
  if (c == "restricted" || c == "regulated") return 3;
  if (c == "secret") return 4;
  return 2;  // unknown is treated as sensitive — never safer
}
bool is_external(const std::string& d) { return d == "approved_vendor" || d == "external_domain" || d == "external_ai_provider" || d == "beneficiary" || d == "external_identity" || d == "partner" || d == "unknown"; }
bool is_untrusted(const std::string& t) { return t == "unverified" || t == "blocked" || t == "unknown"; }
bool is_elevated(const std::string& p) { return p == "elevated" || p == "admin" || p == "unknown"; }
double clamp(double x, double lo, double hi) { return x < lo ? lo : (x > hi ? hi : x); }

int64_t floor_div(int64_t a, int64_t b) {
  int64_t q = a / b;
  return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q;
}

int64_t days_from_civil(int64_t y, int64_t m, int64_t d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

struct Window {
  int n5 = 0, n60 = 0, n_base = 0, unique_dest_1h = 0;
};

Window window_counts(const ActorState& st, int64_t t) {
  Window w;
  std::unordered_set<std::string> dests;
  for (const auto& [ts, dh] : st.times) {
    if (ts > t || ts <= t - kDay) continue;
    if (ts > t - k5m) ++w.n5;
    if (ts > t - kHour) {
      ++w.n60;
      if (!dh.empty()) dests.insert(dh);
    } else {
      ++w.n_base;
    }
  }
  w.unique_dest_1h = static_cast<int>(dests.size());
  return w;
}

int unknown_count(const NormalizedEvent& e) {
  int n = 0;
  for (const std::string* v : {&e.actor_type, &e.privilege_level, &e.action_type, &e.classification, &e.destination_type, &e.destination_trust, &e.device_posture, &e.environment})
    n += *v == "unknown";
  return n;
}

double median(std::vector<double> xs) {
  std::sort(xs.begin(), xs.end());
  const size_t n = xs.size(), m = n / 2;
  return n % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2.0;
}

}  // namespace

int64_t parse_timestamp(const std::string& ts, SchemaError* err) {
  static const std::regex re(R"(^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$)");
  std::smatch m;
  if (!std::regex_match(ts, m, re)) {
    *err = {"timestamp", "expected YYYY-MM-DDTHH:MM:SS[.mmm]Z"};
    return 0;
  }
  auto num = [&](int i) { return std::stoll(m[i].str()); };
  const int64_t y = num(1), mo = num(2), d = num(3), h = num(4), mi = num(5), s = num(6);
  std::string frac = m[7].matched ? m[7].str() : "0";
  while (frac.size() < 3) frac += '0';
  const int64_t ms = std::stoll(frac);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && s < 60)) {
    *err = {"timestamp", "timestamp out of range"};
    return 0;
  }
  return days_from_civil(y, mo, d) * kDay + h * kHour + mi * 60'000 + s * 1000 + ms;
}

std::variant<NormalizedEvent, SchemaError> validate(const Value& e) {
  if (!e.is_object()) return SchemaError{"event", "must be an object"};
  const Value* schema = e.get("schema");
  if (!schema || !schema->is_string() || schema->s != kEventSchema) return SchemaError{"schema", "expected 'endpoint-event/1'"};
  NormalizedEvent n;
  const Value* eid = e.get("event_id");
  if (!eid || !eid->is_string() || eid->s.empty() || eid->s.size() > 128) return SchemaError{"event_id", "required string <=128"};
  n.event_id = eid->s;
  const Value* ts = e.get("timestamp");
  if (!ts || !ts->is_string()) return SchemaError{"timestamp", "required string"};
  SchemaError err;
  n.ts_ms = parse_timestamp(ts->s, &err);
  if (!err.field.empty()) return err;
  if (const Value* tz = e.get("tz_offset_minutes")) {
    if (!tz->is_int() || tz->i < -840 || tz->i > 840) return SchemaError{"tz_offset_minutes", "integer in [-840, 840]"};
    n.tz_offset_minutes = static_cast<int>(tz->i);
  }
  const Value* actor = e.get("actor");
  const Value* aid = actor ? actor->get("id") : nullptr;
  if (!actor || !actor->is_object() || !aid || !aid->is_string() || aid->s.empty()) return SchemaError{"actor.id", "required"};
  const Value* action = e.get("action");
  if (!action || !action->is_object()) return SchemaError{"action", "required object"};
  static const Value kEmpty = [] { Value v; v.kind = Value::Kind::Object; v.obj = std::make_shared<json::Object>(); return v; }();
  auto obj_or_empty = [&](const char* key, const Value*& out) -> bool {
    const Value* v = e.get(key);
    if (!v || v->is_null()) { out = &kEmpty; return true; }
    out = v;
    return v->is_object();
  };
  const Value *resource, *dest, *bc;
  if (!obj_or_empty("resource", resource)) return SchemaError{"resource", "must be an object"};
  n.resource_count = 1;
  if (const Value* c = resource->get("count")) {
    if (!c->is_int() || c->i < 0 || c->i > 10'000'000) return SchemaError{"resource.count", "integer in [0, 10^7]"};
    n.resource_count = c->i;
  }
  if (!obj_or_empty("destination", dest)) return SchemaError{"destination", "must be an object"};
  if (const Value* dh = dest->get("domain_hash")) {
    if (!dh->is_string()) return SchemaError{"destination.domain_hash", "16 lowercase hex chars"};
    n.destination_hash = dh->s;
  }
  if (!n.destination_hash.empty()) {
    bool ok = n.destination_hash.size() == 16 && std::all_of(n.destination_hash.begin(), n.destination_hash.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
    if (!ok) return SchemaError{"destination.domain_hash", "16 lowercase hex chars"};
  }
  if (!obj_or_empty("business_context", bc)) return SchemaError{"business_context", "must be an object"};
  if (const Value* a = bc->get("amount_usd")) {
    if (!a->is_number() || std::isnan(a->number()) || a->number() < 0 || a->number() > 1e10) return SchemaError{"business_context.amount_usd", "number in [0, 1e10]"};
    n.amount_usd = a->number();
  }
  if (const Value* cw = bc->get("change_window"); cw && !cw->is_null()) {
    if (!cw->is_bool()) return SchemaError{"business_context.change_window", "boolean or null"};
    n.change_window = cw->b;
  }
  if (const Value* t = bc->get("ticket")) n.has_ticket = (t->is_bool() && t->b) || (t->is_number() && t->number() != 0) || (t->is_string() && !t->s.empty());
  if (const Value* tool = action->get("tool"); tool && !tool->is_null()) {
    if (!tool->is_string() || tool->s.size() > 120) return SchemaError{"action.tool", "string <=120"};
    n.tool = tool->s;
  }
  n.actor_id = aid->s;
  n.actor_type = enum_of(actor->get("type"), kActorTypes);
  n.privilege_level = enum_of(actor->get("privilege_level"), kPrivilege);
  n.action_type = enum_of(action->get("type"), kActionTypes);
  n.tool_risk_class = enum_of(action->get("tool_risk_class"), kToolRisk);
  n.classification = enum_of(resource->get("classification"), kClassifications);
  const Value* dt = dest->get("type");
  Value none_v;
  none_v.kind = Value::Kind::String;
  none_v.s = "none";
  if (!dt) dt = &none_v;
  n.destination_type = enum_of(dt, kDestTypes);
  const bool raw_none = dt->is_string() && dt->s == "none";
  n.destination_trust = raw_none ? "trusted" : enum_of(dest->get("trust"), kDestTrust);
  const Value* env = e.get("environment");
  n.environment = enum_of(env ? env : &none_v, kEnv);
  n.device_posture = enum_of(e.get("device_posture"), kPosture);
  return n;
}

const std::vector<std::string>& feature_names() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& [block, vocab] : kBlocks) {
      for (const auto& v : *vocab) out.push_back(block + "=" + v);
      out.push_back(block + "=unknown");
    }
    out.insert(out.end(), kNumeric.begin(), kNumeric.end());
    return out;
  }();
  return names;
}

std::vector<double> compute(const NormalizedEvent& e, FeatureState& state) {
  ActorState& st = state.get(e.actor_id);
  const Window w = window_counts(st, e.ts_ms);
  const int64_t local = e.ts_ms + static_cast<int64_t>(e.tz_offset_minutes) * 60'000;
  const int64_t day = floor_div(local, kDay);
  const int hour = static_cast<int>((local - day * kDay) / kHour);
  const int weekday = static_cast<int>(((day + 4) % 7 + 7) % 7);
  const bool weekend = weekday == 0 || weekday == 6;
  const bool off_hours = weekend || hour < 8 || hour >= 19;

  const bool has_dest = e.destination_type != "none";
  const bool first_dest = has_dest && (e.destination_hash.empty() || !st.seen_dest.count(e.destination_hash));
  const bool first_tool = e.tool.empty() || !st.seen_tool.count(e.tool);
  const bool first_action = !st.seen_action.count(e.action_type);

  const double x = std::log1p(static_cast<double>(e.resource_count));
  double resource_z = 0.0;
  if (st.n >= kMinBaseline) {
    const double z = (x - st.mean) / std::sqrt(st.m2 / static_cast<double>(st.n) + 0.25);
    resource_z = clamp(z, -5.0, 5.0) / 5.0;
  }
  const double base_rate = w.n_base / 23.0;
  const double rate_ratio = clamp(std::log2((w.n60 + 1.0) / (base_rate + 1.0)), -4.0, 6.0) / 6.0;
  const int rank = class_rank(e.classification);
  const bool sensitive = rank >= 2;
  const bool external = is_external(e.destination_type);
  const bool elevated = is_elevated(e.privilege_level);
  auto b = [](bool c) { return c ? 1.0 : 0.0; };

  std::vector<double> v;
  v.reserve(feature_names().size());
  const std::array<const std::string*, 9> values = {&e.actor_type, &e.action_type, &e.classification, &e.destination_type, &e.destination_trust, &e.privilege_level, &e.device_posture, &e.tool_risk_class, &e.environment};
  for (size_t k = 0; k < kBlocks.size(); ++k) {
    const auto& vocab = *kBlocks[k].second;
    auto it = std::find(vocab.begin(), vocab.end(), *values[k]);
    const size_t idx = it == vocab.end() ? vocab.size() : static_cast<size_t>(it - vocab.begin());
    for (size_t j = 0; j <= vocab.size(); ++j) v.push_back(j == idx ? 1.0 : 0.0);
  }
  v.push_back(std::min(x, 16.0) / 16.0);
  v.push_back(std::min(std::log10(1.0 + e.amount_usd), 10.0) / 10.0);
  v.push_back(b(off_hours));
  v.push_back(b(weekend));
  v.push_back(b(e.environment == "production" && e.change_window != std::optional<bool>(true)));
  v.push_back(b(e.has_ticket));
  v.push_back(std::min(std::log1p(static_cast<double>(w.n5)), 8.0) / 8.0);
  v.push_back(std::min(std::log1p(static_cast<double>(w.n60)), 8.0) / 8.0);
  v.push_back(rate_ratio);
  v.push_back(std::min(std::log1p(static_cast<double>(w.unique_dest_1h)), 6.0) / 6.0);
  v.push_back(b(first_dest));
  v.push_back(b(first_tool));
  v.push_back(b(first_action));
  v.push_back(resource_z);
  v.push_back(b(st.n < kMinBaseline));
  v.push_back(std::min(unknown_count(e), 4) / 4.0);
  v.push_back(rank / 4.0);
  v.push_back(b(sensitive && external));
  v.push_back(b(sensitive && has_dest && is_untrusted(e.destination_trust)));
  v.push_back(b(elevated && first_dest));
  v.push_back(b(e.amount_usd >= 10'000 && off_hours));
  v.push_back(b(e.action_type == "destructive_delete" && e.environment == "production"));
  v.push_back(b(first_tool && elevated));
  v.push_back(b(e.classification == "secret" && e.destination_type != "none" && e.destination_type != "internal"));
  v.push_back(b(e.resource_count >= 1000 && sensitive));
  return v;
}

void update(const NormalizedEvent& e, FeatureState& state) {
  ActorState& st = state.get(e.actor_id);
  const int64_t t = e.ts_ms;
  int w60 = 0;
  for (const auto& [ts, dh] : st.times)
    if (t - kHour < ts && ts <= t) ++w60;
  while (!st.times.empty() && st.times.front().first <= t - kDay) st.times.pop_front();
  st.times.emplace_back(t, e.destination_hash);
  while (st.times.size() > kTimesCap) st.times.pop_front();
  if (e.destination_type != "none" && !e.destination_hash.empty() && st.seen_dest.size() < kSeenCap) st.seen_dest.insert(e.destination_hash);
  if (!e.tool.empty() && st.seen_tool.size() < kSeenCap) st.seen_tool.insert(e.tool);
  if (st.seen_action.size() < kSeenCap) st.seen_action.insert(e.action_type);
  const double x = std::log1p(static_cast<double>(e.resource_count));
  st.n += 1;
  const double d = x - st.mean;
  st.mean += d / static_cast<double>(st.n);
  st.m2 += d * (x - st.mean);
  st.vol.push_back(x);
  if (st.vol.size() > kRingCap) st.vol.pop_front();
  st.rate.push_back(static_cast<double>(w60));
  if (st.rate.size() > kRingCap) st.rate.pop_front();
}

Anomaly anomaly(const NormalizedEvent& e, FeatureState& state) {
  ActorState& st = state.get(e.actor_id);
  Anomaly a;
  a.samples = st.vol.size();
  const Window w = window_counts(st, e.ts_ms);
  if (a.samples < kMinAnomaly) return a;
  a.sufficient = true;
  const std::vector<double> vols(st.vol.begin(), st.vol.end()), rates(st.rate.begin(), st.rate.end());
  const double mv = median(vols), mr = median(rates);
  std::vector<double> dv, dr;
  for (double v : vols) dv.push_back(std::fabs(v - mv));
  for (double r : rates) dr.push_back(std::fabs(r - mr));
  const double madv = median(dv), madr = median(dr);
  const double z_vol = (std::log1p(static_cast<double>(e.resource_count)) - mv) / (1.4826 * madv + 0.25);
  const double z_rate = (w.n60 - mr) / (1.4826 * madr + 1.0);
  const bool has_dest = e.destination_type != "none";
  std::vector<std::pair<std::string, double>> c = {
      {"volume", std::max(0.0, z_vol) / 4.0},
      {"rate", std::max(0.0, z_rate) / 4.0},
      {"first_destination", 0.35 * ((has_dest && (e.destination_hash.empty() || !st.seen_dest.count(e.destination_hash))) ? 1.0 : 0.0)},
      {"first_tool", 0.35 * ((e.tool.empty() || !st.seen_tool.count(e.tool)) ? 1.0 : 0.0)},
      {"first_action", 0.35 * (st.seen_action.count(e.action_type) ? 0.0 : 1.0)},
  };
  double s = 0.0;
  for (const auto& [k, v] : c) s += v;
  c.erase(std::remove_if(c.begin(), c.end(), [](const auto& p) { return p.second <= 0; }), c.end());
  std::sort(c.begin(), c.end(), [](const auto& x, const auto& y) { return x.second != y.second ? x.second > y.second : x.first < y.first; });
  a.score = 1.0 - std::exp(-s);
  a.contributions = std::move(c);
  return a;
}

}  // namespace orbis

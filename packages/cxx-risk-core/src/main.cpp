// orbis-risk-core — C++20 CLI for the edge feature calculator.
//   orbis-risk-core features            < stream.jsonl   → JSONL feature vectors + anomaly
//   orbis-risk-core parity  <feature-parity.json>        → compare against the Python reference
//   orbis-risk-core bench   <feature-parity.json> [reps] → throughput / latency
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

#include "orbis/features.hpp"

using namespace orbis;

static std::string slurp(const char* path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error(std::string("cannot open ") + path);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

static int cmd_features() {
  FeatureState st;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    auto parsed = json::parse(line);
    auto r = validate(parsed);
    const auto* eid = parsed.get("event_id");
    std::string id = eid && eid->is_string() ? eid->s : "";
    if (auto* err = std::get_if<SchemaError>(&r)) {
      std::cout << R"({"event_id":")" << id << R"(","error":{"field":")" << err->field << R"(","message":")" << err->message << "\"}}\n";
      continue;
    }
    const auto& ev = std::get<NormalizedEvent>(r);
    auto x = compute(ev, st);
    auto a = anomaly(ev, st);
    update(ev, st);
    std::cout << R"({"event_id":")" << id << R"(","features":[)";
    for (size_t i = 0; i < x.size(); ++i) std::cout << (i ? "," : "") << json::dump_double(x[i]);
    std::cout << R"(],"anomaly":{"score":)" << json::dump_double(a.score) << R"(,"sufficient":)" << (a.sufficient ? "true" : "false") << R"(,"contributions":[)";
    for (size_t i = 0; i < a.contributions.size(); ++i) std::cout << (i ? "," : "") << R"({"feature":")" << a.contributions[i].first << R"(","weight":)" << json::dump_double(a.contributions[i].second) << "}";
    std::cout << "]}}\n";
  }
  return 0;
}

static int cmd_parity(const char* path) {
  auto doc = json::parse(slurp(path));
  const auto& names = feature_names();
  const auto& ref_names = *doc.get("feature_names")->arr;
  if (ref_names.size() != names.size()) { std::fprintf(stderr, "feature count %zu != %zu\n", names.size(), ref_names.size()); return 1; }
  for (size_t i = 0; i < names.size(); ++i)
    if (ref_names[i].s != names[i]) { std::fprintf(stderr, "feature %zu name %s != %s\n", i, names[i].c_str(), ref_names[i].s.c_str()); return 1; }
  size_t vectors = 0, mismatches = 0, exact = 0;
  double max_delta = 0;
  for (const auto& s : *doc.get("streams")->arr) {
    FeatureState st;
    const auto& events = *s.get("events")->arr;
    const auto& expected = *s.get("expected")->arr;
    for (size_t k = 0; k < events.size(); ++k) {
      auto r = validate(events[k]);
      if (std::holds_alternative<SchemaError>(r)) { ++mismatches; continue; }
      const auto& ev = std::get<NormalizedEvent>(r);
      auto x = compute(ev, st);
      auto a = anomaly(ev, st);
      update(ev, st);
      const auto& ref = *expected[k].get("features")->arr;
      bool same = true, bitwise = true;
      for (size_t i = 0; i < x.size(); ++i) {
        double d = std::fabs(x[i] - ref[i].number());
        max_delta = std::max(max_delta, d);
        if (d > 1e-9) same = false;
        if (x[i] != ref[i].number()) bitwise = false;
      }
      const auto& ra = *expected[k].get("anomaly");
      if (std::fabs(a.score - ra.get("score")->number()) > 1e-9 || a.sufficient != ra.get("sufficient")->b) same = false;
      const auto& rc = *ra.get("contributions")->arr;
      if (rc.size() != a.contributions.size()) same = false;
      else for (size_t i = 0; i < rc.size(); ++i) if (rc[i].get("feature")->s != a.contributions[i].first) same = false;
      if (!same) { ++mismatches; std::fprintf(stderr, "mismatch %s / %s\n", s.get("name")->s.c_str(), ev.event_id.c_str()); }
      exact += bitwise;
      ++vectors;
    }
  }
  size_t invalid_ok = 0, invalid_total = 0;
  for (const auto& c : *doc.get("invalid")->arr) {
    ++invalid_total;
    auto r = validate(*c.get("event"));
    if (auto* err = std::get_if<SchemaError>(&r); err && err->field == c.get("field")->s) ++invalid_ok;
    else std::fprintf(stderr, "invalid case not rejected on same field: %s\n", c.get("name")->s.c_str());
  }
  std::printf("{\"implementation\":\"c++20\",\"vectors\":%zu,\"mismatches\":%zu,\"bit_identical_vectors\":%zu,\"max_abs_delta\":%s,\"invalid_rejected\":\"%zu/%zu\",\"tolerance\":1e-9,\"passed\":%s}\n",
              vectors, mismatches, exact, json::dump_double(max_delta).c_str(), invalid_ok, invalid_total, (mismatches == 0 && invalid_ok == invalid_total) ? "true" : "false");
  return (mismatches == 0 && invalid_ok == invalid_total) ? 0 : 1;
}

static int cmd_bench(const char* path, int reps) {
  auto doc = json::parse(slurp(path));
  std::vector<NormalizedEvent> events;
  for (const auto& s : *doc.get("streams")->arr)
    for (const auto& e : *s.get("events")->arr)
      if (auto r = validate(e); std::holds_alternative<NormalizedEvent>(r)) events.push_back(std::get<NormalizedEvent>(r));
  std::vector<double> lat;
  lat.reserve(events.size() * reps);
  double sink = 0;
  auto t0 = std::chrono::steady_clock::now();
  for (int r = 0; r < reps; ++r) {
    FeatureState st;
    for (const auto& ev : events) {
      auto a = std::chrono::steady_clock::now();
      auto x = compute(ev, st);
      auto an = anomaly(ev, st);
      update(ev, st);
      sink += x[0] + an.score;
      lat.push_back(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - a).count());
    }
  }
  double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::sort(lat.begin(), lat.end());
  auto p = [&](double q) { return lat[static_cast<size_t>(q * (lat.size() - 1))]; };
  std::printf("{\"implementation\":\"c++20\",\"events\":%zu,\"p50_us\":%.3f,\"p95_us\":%.3f,\"p99_us\":%.3f,\"throughput_per_s\":%.0f,\"sink\":%.1f}\n", lat.size(), p(0.5), p(0.95), p(0.99), lat.size() / wall, sink);
  return 0;
}

int main(int argc, char** argv) {
  try {
    std::string cmd = argc > 1 ? argv[1] : "";
    if (cmd == "features") return cmd_features();
    if (cmd == "parity" && argc > 2) return cmd_parity(argv[2]);
    if (cmd == "bench" && argc > 2) return cmd_bench(argv[2], argc > 3 ? std::stoi(argv[3]) : 20);
    std::fprintf(stderr, "usage: orbis-risk-core features < stream.jsonl | parity <feature-parity.json> | bench <feature-parity.json> [reps]\n");
    return 2;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "error: %s\n", e.what());
    return 1;
  }
}

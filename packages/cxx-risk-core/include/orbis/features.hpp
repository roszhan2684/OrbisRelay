// C++20 port of the Orbis edge feature calculator (edge-features/1) and the robust behavioural
// anomaly scorer. Reference: ml/orbis_ml/{schema,features}.py. Translated line by line from the
// versioned Python spec — not rewritten by guesswork — and checked against the shared parity corpus.
#pragma once

#include <array>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

#include "orbis/json.hpp"

namespace orbis {

inline constexpr const char* kFeatureSchema = "edge-features/1";
inline constexpr const char* kEventSchema = "endpoint-event/1";

struct SchemaError {
  std::string field;
  std::string message;
};

struct NormalizedEvent {
  std::string event_id;
  int64_t ts_ms = 0;
  int tz_offset_minutes = 0;
  std::string actor_id, actor_type, privilege_level, action_type, tool, tool_risk_class, classification;
  int64_t resource_count = 1;
  std::string destination_type, destination_trust, destination_hash, environment, device_posture;
  double amount_usd = 0.0;
  std::optional<bool> change_window;
  bool has_ticket = false;
};

/// Validate an endpoint-event/1 document. Returns the error (same field names as Python) or the event.
std::variant<NormalizedEvent, SchemaError> validate(const json::Value& e);
int64_t parse_timestamp(const std::string& ts, SchemaError* err);

struct ActorState {
  std::deque<std::pair<int64_t, std::string>> times;
  std::unordered_set<std::string> seen_dest, seen_tool, seen_action;
  int64_t n = 0;
  double mean = 0.0, m2 = 0.0;
  std::deque<double> vol, rate;  // bounded rings (200)
};

class FeatureState {
 public:
  ActorState& get(const std::string& actor) { return actors_[actor]; }
  size_t size() const { return actors_.size(); }

 private:
  std::unordered_map<std::string, ActorState> actors_;
};

struct Anomaly {
  double score = 0.0;
  bool sufficient = false;
  size_t samples = 0;
  std::vector<std::pair<std::string, double>> contributions;
};

const std::vector<std::string>& feature_names();
std::vector<double> compute(const NormalizedEvent& e, FeatureState& state);
void update(const NormalizedEvent& e, FeatureState& state);
Anomaly anomaly(const NormalizedEvent& e, FeatureState& state);

}  // namespace orbis

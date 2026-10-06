# Orbis C++20 parity module. No dependencies beyond a C++20 compiler.
CXX ?= clang++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Wpedantic -Iinclude
SRC = src/json.cpp src/features.cpp src/main.cpp
FIXTURE = ../../fixtures/endpoint-events/feature-parity.json

build/orbis-risk-core: $(SRC) include/orbis/*.hpp
	@mkdir -p build
	$(CXX) $(CXXFLAGS) $(SRC) -o $@

build/orbis-risk-core-asan: $(SRC) include/orbis/*.hpp
	@mkdir -p build
	$(CXX) -std=c++20 -O1 -g -Iinclude -fsanitize=address,undefined -fno-omit-frame-pointer $(SRC) -o $@

.PHONY: test sanitize bench clean
test: build/orbis-risk-core
	./build/orbis-risk-core parity $(FIXTURE)

sanitize: build/orbis-risk-core-asan
	./build/orbis-risk-core-asan parity $(FIXTURE)

bench: build/orbis-risk-core
	./build/orbis-risk-core bench $(FIXTURE) 50

clean:
	rm -rf build

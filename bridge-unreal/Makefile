# Builds TelosBridgeUE.dll with MinGW-w64 (x86_64 -> Windows x64).
# Needs: x86_64-w64-mingw32-g++ (apt install g++-mingw-w64-x86-64).
# The DLL is injected into a running Unreal game; see README.md.
# (Assigned, not ?= : make's built-in default CXX=g++ would otherwise win.)
CXX = x86_64-w64-mingw32-g++
CXXFLAGS = -std=c++17 -O2 -Wall -Wextra -D_WIN32_WINNT=0x0601
LDFLAGS = -shared -static-libgcc -static-libstdc++ -lwinhttp -lpsapi
SRC = src/dllmain.cpp src/adapter.cpp src/ue.cpp
OUT = TelosBridgeUE.dll

all: $(OUT)

$(OUT): $(SRC) src/ue.h src/json.h
	$(CXX) $(CXXFLAGS) -o $@ $(SRC) $(LDFLAGS)
	@echo "Built bridge-unreal/$(OUT) ($$(wc -c < $(OUT)) bytes)"

clean:
	rm -f $(OUT) test/test_json

# Host-side protocol test: compiles json.h with the native compiler and runs it.
# The DLL itself is only validated against a real Unreal game (see README.md).
test: test/test_json
	./test/test_json

test/test_json: test/test_json.cpp src/json.h
	g++ -std=c++17 -O1 -Wall -Wextra -o $@ test/test_json.cpp

.PHONY: all clean test

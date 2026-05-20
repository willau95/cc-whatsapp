.PHONY: all build plugin clean

ROOT := $(shell pwd)
BIN := $(ROOT)/bin/cc-whatsapp

all: build plugin

build:
	cd server && CGO_ENABLED=1 CGO_CFLAGS=-Wno-error=missing-braces \
	  go build -tags sqlite_fts5 -trimpath \
	  -o $(BIN) ./cmd/cc-whatsapp
	@echo "✓ built $(BIN)"
	@$(BIN) version

plugin:
	cd plugin && bun install --no-summary
	@echo "✓ plugin deps installed"

clean:
	rm -f $(BIN)
	rm -rf plugin/node_modules plugin/bun.lock

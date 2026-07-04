.DEFAULT_GOAL := help
.PHONY: help build up login verify rebuild daemon daemon-logs daemon-stop \
        autostart-install autostart-uninstall down logs clean

AUTOSTART_PLIST := $(HOME)/Library/LaunchAgents/com.zalo-personal-mcp.daemon.plist

## help: list available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'

## build: build the MCP server image
build:
	docker compose build

## up: start the egress-proxy (the sandbox security boundary)
up:
	docker compose up -d egress-proxy

## login: one-time interactive QR login inside the sandbox (writes ./.zalo/qr.png)
login: build up
	docker compose run --rm -T zalo-mcp node dist/login.js

## verify: prove the sandbox actually contains egress to Zalo only
verify: up
	./sandbox/verify.sh

## rebuild: rebuild the image after code changes, then reconnect the client (steps printed)
rebuild:
	docker compose build
	@if [ -n "$$(docker compose ps -q zalo-daemon 2>/dev/null)" ]; then \
		echo "-> daemon is running; recreating it with the new image"; \
		echo "   (ensure ZALO_SESSION_KEY is set in this shell if you use a passphrase)"; \
		docker compose up -d --force-recreate --no-deps zalo-daemon; \
	fi
	@echo ""
	@echo "OK: image rebuilt. A NEW Claude Code session picks it up automatically."
	@echo "To update a CURRENT session (e.g. to see new/changed tools), reconnect:"
	@echo "  run  /mcp  in Claude Code  ->  select 'zalo'  ->  reconnect"
	@echo "  (or just start a new session)"

## daemon: start the background message-capture daemon (logs incoming messages)
daemon: build up
	docker compose up -d zalo-daemon

## daemon-logs: tail the daemon logs
daemon-logs:
	docker compose logs -f zalo-daemon

## daemon-stop: stop the message-capture daemon
daemon-stop:
	docker compose stop zalo-daemon

## autostart-install: run the daemon at macOS login (LaunchAgent; passphrase from Keychain)
autostart-install:
	bash sandbox/install-autostart.sh

## autostart-uninstall: remove the login autostart
autostart-uninstall:
	launchctl unload "$(AUTOSTART_PLIST)" 2>/dev/null || true
	rm -f "$(AUTOSTART_PLIST)"
	@echo "removed $(AUTOSTART_PLIST)"

## logs: tail the egress-proxy (Squid) logs
logs:
	docker compose logs -f egress-proxy

## down: stop and remove the sandbox containers
down:
	docker compose down

## clean: down + remove built image and dangling volumes
clean: down
	docker compose down --rmi local --volumes --remove-orphans

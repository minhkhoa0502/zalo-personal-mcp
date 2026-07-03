.DEFAULT_GOAL := help
.PHONY: help build up login verify down logs clean

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

## logs: tail the egress-proxy (Squid) logs
logs:
	docker compose logs -f egress-proxy

## down: stop and remove the sandbox containers
down:
	docker compose down

## clean: down + remove built image and dangling volumes
clean: down
	docker compose down --rmi local --volumes --remove-orphans

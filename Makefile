.PHONY: deps up up-mq down ps logs test lint token smoke

deps:
	npm.cmd --prefix services/reservation ci
	npm.cmd --prefix services/member ci

up:
	docker compose up -d --build

up-mq:
	COMPOSE_PROFILES=mq docker compose up -d --build

down:
	docker compose down -v --remove-orphans

ps:
	docker compose ps

logs:
	docker compose logs -f reservation member

lint:
	npm.cmd --prefix services/reservation run lint
	npm.cmd --prefix services/member run lint

test:
	npm.cmd --prefix services/reservation test
	npm.cmd --prefix services/member test

token:
	node scripts/generate-jwt.mjs

smoke:
	node scripts/smoke.mjs

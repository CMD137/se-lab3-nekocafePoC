.PHONY: up up-mq down ps logs test lint token smoke

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
	node scripts/generate-jwt.mjs > .token.tmp
	@echo "Use the token in .token.tmp to call the APIs."

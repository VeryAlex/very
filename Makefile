PORT ?= 3100

.PHONY: user up down build run stop db-up db-down db-reset

# Whole app: Postgres (waits until healthy), then the server in the foreground.
up: db-up run

# Stops the server and the database.
down: stop db-down

db-up:
	docker compose up -d --wait db

db-down:
	docker compose down

# Drops the volume, so schema.sql is applied again on next db-up.
db-reset:
	docker compose down -v
	docker compose up -d --wait db

# No bundling step exists: install deps and syntax-check the backend.
build:
	npm install
	find src -name '*.js' -exec node --check {} \;

# Foreground; reads DATABASE_URL and Avito vars from .env if present.
run:
	PORT=$(PORT) node --env-file-if-exists=.env src/server.js

# make user USER_EMAIL=me@x.io USER_PASSWORD=secret123 [USER_NAME=Me] [USER_ROLE=manager]
user:
	node --env-file-if-exists=.env scripts/create-user.js

# Kills whatever listens on $(PORT).
stop:
	-lsof -ti tcp:$(PORT) | xargs kill

.PHONY: up down restart ps logs build-dataset test clean

up:
	docker compose up -d --build

down:
	docker compose down

restart:
	docker compose down && docker compose up -d --build

ps:
	docker compose ps

logs:
	docker compose logs -f alloy loki simulator dataset-builder

build-dataset:
	docker compose run --rm --no-deps dataset-builder \
		python -m dataset_builder.build_dataset \
		--log-file /var/log/machines/telemetry.jsonl \
		--segments-dir /var/log/machines/segments \
		--quarantine-file /var/log/machines/quarantine.jsonl \
		--checkpoint-file /var/log/machines/state/builder_checkpoint.json \
		--contract-file /var/log/machines/telemetry_contract.json \
		--out-dir /var/log/machines/ml_dataset \
		--window-minutes 5 \
		--watermark-lookback-minutes 15 \
		--horizon-windows 1 \
		--once \
		--upload-s3 \
		--write-postgres

test:
	docker compose build simulator
	docker compose run --rm --no-deps --entrypoint pytest \
		-v $(CURDIR)/tests:/app/tests:ro \
		-v $(CURDIR)/deploy:/app/deploy:ro \
		simulator -v /app/tests

clean:
	docker compose down -v --remove-orphans

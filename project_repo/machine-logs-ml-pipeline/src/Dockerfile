FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY pyproject.toml requirements-lock.txt /app/
COPY simulator /app/simulator
COPY dataset_builder /app/dataset_builder
COPY edge_gateway /app/edge_gateway

# Exact, hash-verified versions from the lock; the package itself adds no extra resolution.
RUN pip install --no-cache-dir --require-hashes -r requirements-lock.txt \
    && pip install --no-cache-dir --no-deps .

RUN mkdir -p /var/log/machines

CMD ["python", "-m", "simulator.main"]

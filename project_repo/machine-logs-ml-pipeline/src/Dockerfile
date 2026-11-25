FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY pyproject.toml /app/pyproject.toml
COPY simulator /app/simulator
COPY dataset_builder /app/dataset_builder
COPY edge_gateway /app/edge_gateway

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir ".[dev,edge]"

RUN mkdir -p /var/log/machines

CMD ["python", "-m", "simulator.main"]

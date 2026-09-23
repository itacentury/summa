FROM python:3.12-slim AS builder

# Provide uv (pinned for reproducible builds)
COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /bin/

WORKDIR /app

# Compile bytecode at build time for faster container startup; copy out of the
# cache mount instead of hardlinking across filesystems
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# Install runtime dependencies only (no dev group, no editable install of the app)
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

FROM python:3.12-slim

LABEL org.opencontainers.image.title="Summa"
LABEL org.opencontainers.image.description="Invoice management and expense tracking"
LABEL org.opencontainers.image.source="https://github.com/itacentury/summa"

WORKDIR /app

# Upgrade base packages for CVE fixes, create the non-root user and the data
# directory for the SQLite database. Privilege dropping at startup uses setpriv
# (from util-linux, already in the base image) — no extra package needed.
RUN apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash appuser \
    && mkdir -p /data && chown appuser:appuser /data

# The virtualenv is self-contained; nothing else is needed from the builder
COPY --from=builder /app/.venv /app/.venv

# Copy application files
COPY summa/ summa/
COPY templates/ templates/
COPY static/ static/
# Only the benchmark refresh (.dockerignore whitelists its three files)
COPY scripts/ scripts/

COPY --chmod=755 entrypoint.sh /entrypoint.sh

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/data/invoices.db

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/')" || exit 1

# Use entrypoint for permission handling, then run gunicorn
ENTRYPOINT ["/entrypoint.sh"]
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "summa.wsgi:app"]

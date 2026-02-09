# Summa

Invoice management and expense tracking web application.

## Requirements

- Python 3.12+
- Docker (optional)

## Quick Start

### Docker (Recommended)

```bash
docker compose up -d
```

The application runs at `http://localhost:8000`. Data is persisted in a Docker volume.

See [`docker-compose.yml`](docker-compose.yml) for the full configuration including health checks and volume setup.

### Local Development

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the application
flask run
```

The application runs at `http://localhost:8000` with the database stored in `invoices.db`.

## Configuration

| Environment Variable | Default       | Description             |
| -------------------- | ------------- | ----------------------- |
| `DATABASE_PATH`      | `invoices.db` | Path to SQLite database |

## API

The application provides REST endpoints at `/api/invoices` for managing invoice data.

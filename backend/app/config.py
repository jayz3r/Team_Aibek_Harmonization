from dataclasses import dataclass, field
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ORIGINS = ",".join([
    "http://localhost:3000", "http://127.0.0.1:3000",
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:4173", "http://127.0.0.1:4173",
])


def _origins(raw):
    """Comma-separated origins; tolerate spaces and trailing slashes."""
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


def _optional_path(raw):
    return Path(raw) if raw else None


def read_dotenv(path):
    """Minimal KEY=VALUE reader (no dependency). Missing file -> empty dict."""
    values = {}
    try:
        lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            values[key] = value
    return values


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", "data")))
    api_key: str = field(default_factory=lambda: os.getenv("API_KEY", ""))
    firms_map_key: str = field(default_factory=lambda: os.getenv("FIRMS_MAP_KEY", ""))
    cors_origins: list[str] = field(default_factory=lambda: _origins(os.getenv("CORS_ORIGINS", DEFAULT_ORIGINS)))
    # Built React app (frontend/dist). When index.html exists it is served at "/".
    frontend_dist: Path | None = field(default_factory=lambda: _optional_path(
        os.getenv("FRONTEND_DIST", str(ROOT.parent / "frontend" / "dist"))))
    demo_sample: Path = field(default_factory=lambda: ROOT / "examples" / "china_sample.csv")
    max_upload_bytes: int = 256 * 1024 * 1024
    max_uncompressed_bytes: int = 2 * 1024 * 1024 * 1024
    max_rows: int = 30_000_000
    chunk_rows: int = 100_000
    grid_km: float = 10.0
    region_km: float = 100.0
    memory_limit: str = "3GB"

    @classmethod
    def from_env(cls, dotenv=None):
        """Settings for the real server/CLI: process environment first, then backend/.env.

        Plain ``Settings()`` (used by tests) never reads .env, so a local key file
        cannot change test behaviour.
        """
        file = read_dotenv(dotenv or ROOT / ".env")

        def pick(name, default=""):
            if os.environ.get(name):
                return os.environ[name]
            if file.get(name):
                return file[name]
            # Present but blank means "explicitly disabled", not "use the default".
            return "" if (name in os.environ or name in file) else default

        return cls(
            data_dir=Path(pick("DATA_DIR", "data")),
            api_key=pick("API_KEY"),
            firms_map_key=pick("FIRMS_MAP_KEY"),
            cors_origins=_origins(pick("CORS_ORIGINS", DEFAULT_ORIGINS)),
            frontend_dist=_optional_path(pick("FRONTEND_DIST", str(ROOT.parent / "frontend" / "dist"))),
        )


class InputError(ValueError):
    pass


class ConflictError(ValueError):
    pass


class NotFoundError(KeyError):
    """Unknown job/model id. A dedicated type so real KeyError bugs are not reported as 404."""

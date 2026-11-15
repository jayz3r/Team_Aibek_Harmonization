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


def container_memory_bytes():
    """RAM limit of the container (cgroup v2, then v1); None on a normal machine or when unknown."""
    for name in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = Path(name).read_text().strip()
            value = int(raw)
        except (OSError, ValueError):
            continue
        if 0 < value < 64 * 1024 ** 3:  # "max" / 2**63 mean "no limit"
            return value
    return None


def sized_for(memory_bytes):
    """(DuckDB memory_limit, CSV chunk rows) that fit a host. Small hosts (Render free = 512 MB) get small numbers."""
    if not memory_bytes or memory_bytes >= 6 * 1024 ** 3:
        return "3GB", 100_000
    megabytes = memory_bytes // (1024 * 1024)
    return f"{max(96, int(megabytes * 0.4))}MB", (25_000 if megabytes <= 1536 else 50_000)


def _positive_int(raw, default, low, high):
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return default
    return value if low <= value <= high else default


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
    # Import the bundled sample into an EMPTY database at start-up (hosts that wipe the disk on restart).
    autoload_demo: bool = False

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

        try:
            memory_limit, chunk_rows = sized_for(container_memory_bytes())
        except Exception:  # never let host probing stop the server
            memory_limit, chunk_rows = "3GB", 100_000
        custom_memory = pick("DUCKDB_MEMORY_LIMIT").replace(" ", "")
        if custom_memory and custom_memory[:1].isdigit() and custom_memory.upper().endswith(("MB", "GB", "MIB", "GIB")):
            memory_limit = custom_memory
        return cls(
            memory_limit=memory_limit,
            chunk_rows=_positive_int(pick("CHUNK_ROWS"), chunk_rows, 1_000, 1_000_000),
            max_upload_bytes=_positive_int(pick("MAX_UPLOAD_MB"), 256, 1, 4096) * 1024 * 1024,
            autoload_demo=pick("AUTOLOAD_DEMO").strip().lower() in ("1", "true", "yes", "on"),
            data_dir=Path(pick("DATA_DIR", "data")),
            api_key=pick("API_KEY"),
            firms_map_key=pick("FIRMS_MAP_KEY"),
            cors_origins=_origins(pick("CORS_ORIGINS", DEFAULT_ORIGINS)),
            frontend_dist=_optional_path(pick("FRONTEND_DIST", str(ROOT.parent / "frontend" / "dist"))),
        )


class InputError(ValueError):
    pass


class UploadTooLarge(InputError):
    """Reported as HTTP 413."""


class ConflictError(ValueError):
    pass


class NotFoundError(KeyError):
    """Unknown job/model id. A dedicated type so real KeyError bugs are not reported as 404."""

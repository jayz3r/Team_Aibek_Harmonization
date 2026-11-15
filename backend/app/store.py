from contextlib import contextmanager
from threading import RLock
import json
from functools import wraps

import duckdb
import pandas as pd

from .config import Settings, ConflictError, NotFoundError
from .geo import EARTH_KM, COS30


def read_snapshot(function):
    @wraps(function)
    def wrapped(store, *args, **kwargs):
        with store.lock:
            return function(store, *args, **kwargs)
    return wrapped


class Store:
    """One process/one writer. A lock and transactions publish consistent snapshots."""

    def __init__(self, settings: Settings):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = settings.data_dir / "fire.duckdb"
        self.lock = RLock()
        self.connection = duckdb.connect(str(self.path))
        self.connection.execute(f"SET memory_limit='{settings.memory_limit}'")
        self.connection.execute("SET threads=2")
        self.connection.execute("SET preserve_insertion_order=false")
        self._initialize()

    @contextmanager
    def db(self):
        # A private cursor per use: a half-read result (fetchone) on one call can never
        # block register()/execute() in another, e.g. status polling during an import.
        with self.lock:
            cursor = self.connection.cursor()
            try:
                yield cursor
            finally:
                cursor.close()

    def close(self):
        with self.lock:
            self.connection.close()

    def _initialize(self):
        with self.db() as c:
            c.execute("""
                CREATE TABLE IF NOT EXISTS meta(key VARCHAR PRIMARY KEY, value VARCHAR);
                CREATE TABLE IF NOT EXISTS datasets(
                    id VARCHAR PRIMARY KEY, name VARCHAR, sha256 VARCHAR,
                    status VARCHAR, created_at TIMESTAMP DEFAULT current_timestamp, audit JSON);
                CREATE TABLE IF NOT EXISTS models(
                    id VARCHAR PRIMARY KEY, created_at TIMESTAMP DEFAULT current_timestamp,
                    revision INTEGER, payload JSON);
                CREATE TABLE IF NOT EXISTS jobs(
                    id VARCHAR PRIMARY KEY, kind VARCHAR, status VARCHAR,
                    created_at TIMESTAMP DEFAULT current_timestamp, result JSON, error VARCHAR);
                CREATE SEQUENCE IF NOT EXISTS observation_seq START 1;
                CREATE TABLE IF NOT EXISTS observations(
                    seq BIGINT DEFAULT nextval('observation_seq'), observation_id VARCHAR,
                    dataset_id VARCHAR, source_member VARCHAR, platform VARCHAR, sensor VARCHAR,
                    observed_at TIMESTAMP, latitude DOUBLE, longitude DOUBLE,
                    brightness_k DOUBLE, brightness_channel VARCHAR, background_k DOUBLE,
                    scan_km DOUBLE, track_km DOUBLE, frp_mw DOUBLE,
                    confidence_raw VARCHAR, confidence_class VARCHAR, quality_pass BOOLEAN,
                    version VARCHAR, processing VARCHAR, hotspot_type INTEGER,
                    daynight VARCHAR, gx INTEGER, gy INTEGER);
                CREATE TABLE IF NOT EXISTS detections AS SELECT * FROM observations WHERE false;
            """)
            expected = {"grid_km": str(self.settings.grid_km), "region_km": str(self.settings.region_km), "schema": "1"}
            for key, value in expected.items():
                old = c.execute("SELECT value FROM meta WHERE key=?", [key]).fetchone()
                if old and old[0] != value:
                    raise ConflictError(f"Database {key}={old[0]}, requested {value}; use a new DATA_DIR")
                c.execute("INSERT INTO meta VALUES (?,?) ON CONFLICT DO NOTHING", [key, value])
            c.execute("INSERT INTO meta VALUES ('revision','0') ON CONFLICT DO NOTHING")
            c.execute("""CREATE TABLE IF NOT EXISTS activity(
                platform VARCHAR, processing VARCHAR, date DATE, daynight VARCHAR,
                hotspot_type INTEGER, gx INTEGER, gy INTEGER,
                detection_count BIGINT, frp_max_mw DOUBLE, longitude DOUBLE, latitude DOUBLE)""")
            c.execute("""UPDATE jobs SET status='interrupted', error='Server restarted; submit the job again'
                         WHERE status IN ('queued','running')""")
            # Unpublished imports left by a crashed process never enter the snapshot.
            c.execute("UPDATE datasets SET status='failed' WHERE status='importing'")

    def revision(self):
        with self.db() as c:
            return int(c.execute("SELECT value FROM meta WHERE key='revision'").fetchone()[0])

    def frame(self, sql, params=None):
        with self.db() as c:
            return c.execute(sql, params or []).fetchdf()

    def records(self, sql, params=None):
        return json.loads(self.frame(sql, params).to_json(orient="records", date_format="iso"))

    def refresh(self, ready_dataset_id=None):
        """Archive preference applies only to EXACT platform/time/location duplicates."""
        g = self.settings.grid_km
        with self.db() as c:
            c.execute("BEGIN")
            try:
                if ready_dataset_id:
                    c.execute("UPDATE datasets SET status='ready' WHERE id=?", [ready_dataset_id])
                c.execute("""
                    CREATE OR REPLACE TABLE detections AS
                    SELECT o.* FROM observations o JOIN datasets d ON d.id=o.dataset_id
                    WHERE d.status='ready'
                    QUALIFY row_number() OVER (PARTITION BY observation_id ORDER BY
                        CASE processing WHEN 'archive' THEN 0 WHEN 'NRT' THEN 1
                        WHEN 'RT' THEN 2 WHEN 'URT' THEN 3 ELSE 4 END, seq DESC)=1
                """)
                c.execute(f"""
                    CREATE OR REPLACE TABLE activity AS
                    SELECT platform, processing, CAST(observed_at AS DATE) AS date, daynight,
                        hotspot_type, gx, gy, count(*) AS detection_count,
                        max(frp_mw) AS frp_max_mw,
                        greatest(-180,least(180,degrees((gx+0.5)*{g}/({EARTH_KM}*{COS30})))) AS longitude,
                        degrees(asin(greatest(-1,least(1,(gy+0.5)*{g}*{COS30}/{EARTH_KM})))) AS latitude
                    FROM detections WHERE quality_pass
                    GROUP BY platform, processing, date, daynight, hotspot_type, gx, gy
                """)
                c.execute("UPDATE meta SET value=CAST(CAST(value AS INTEGER)+1 AS VARCHAR) WHERE key='revision'")
                c.execute("COMMIT")
            except Exception:
                c.execute("ROLLBACK")
                raise

    def get_model(self, model_id):
        with self.db() as c:
            row = c.execute("SELECT revision,payload FROM models WHERE id=?", [model_id]).fetchone()
        if row is None:
            raise NotFoundError("Model not found")
        payload = json.loads(row[1])
        payload["stale"] = row[0] != self.revision()
        return payload

    def latest_model(self):
        """Newest model fitted on the current revision, else the newest stale one, else None."""
        with self.db() as c:
            rows = c.execute("SELECT id,revision FROM models ORDER BY created_at DESC, id LIMIT 50").fetchall()
        if not rows:
            return None
        revision = self.revision()
        chosen = next((row[0] for row in rows if row[1] == revision), rows[0][0])
        return self.get_model(chosen)

    def spans(self, processing="archive"):
        return self.records("""SELECT platform,min(CAST(observed_at AS DATE)) AS start,
             max(CAST(observed_at AS DATE)) AS end, count(*) AS detections,
             min(longitude) AS west,min(latitude) AS south,max(longitude) AS east,max(latitude) AS north
             FROM detections WHERE processing=? GROUP BY platform""", [processing])

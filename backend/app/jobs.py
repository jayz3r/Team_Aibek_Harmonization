from concurrent.futures import ThreadPoolExecutor
import json
import logging
import threading
import uuid

from .config import ConflictError, InputError, NotFoundError

logger = logging.getLogger(__name__)


class JobRunner:
    def __init__(self, store):
        self.store = store
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fire-job")
        self.capacity = threading.BoundedSemaphore(4)

    def submit(self, kind, function):
        if not self.capacity.acquire(blocking=False):
            raise ConflictError("Job queue is full; wait for an active import/calibration to finish")
        job_id = uuid.uuid4().hex
        try:
            with self.store.db() as c:
                c.execute("INSERT INTO jobs(id,kind,status) VALUES (?,?,'queued')", [job_id, kind])
            self.pool.submit(self._run, job_id, function)
        except Exception:
            self.capacity.release()
            raise
        return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/jobs/{job_id}"}

    def _update(self, job_id, status, result=None, error=None):
        with self.store.db() as c:
            c.execute("UPDATE jobs SET status=?,result=?,error=? WHERE id=?",
                      [status, json.dumps(result) if result is not None else None, error, job_id])

    def _run(self, job_id, function):
        self._update(job_id, "running")
        try:
            result = function(lambda progress: self._update(job_id, "running", progress))
            self._update(job_id, "succeeded", result)
        except (InputError, ConflictError) as exc:
            self._update(job_id, "failed", error=str(exc))
        except Exception:
            logger.exception("Job %s failed", job_id)
            self._update(job_id, "failed", error="Processing failed; see server logs. Check file format and available resources.")
        finally:
            self.capacity.release()

    def get(self, job_id):
        rows = self.store.records("SELECT * FROM jobs WHERE id=?", [job_id])
        if not rows:
            raise NotFoundError("Job not found")
        row = rows[0]
        if isinstance(row["result"], str):
            row["result"] = json.loads(row["result"])
        return row

    def close(self):
        self.pool.shutdown(wait=True)

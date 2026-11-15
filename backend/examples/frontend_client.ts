/** Lightweight client for a React/Vue/MapLibre frontend. Dates are YYYY-MM-DD in UTC. */
export type Area = { bbox: [number, number, number, number] } | { polygon: GeoJSONGeometry };
export type GeoJSONGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: unknown[] };
export type Platform = "Terra" | "Aqua" | "SNPP" | "NOAA20" | "NOAA21";
export type Window = {
  start: string;
  end: string;
  area?: Area;
  daynight?: "D" | "N" | "both";
  processing?: "archive" | "NRT" | "RT" | "URT" | "unknown";
  hotspot_scope?: "all" | "vegetation";
};
export type CalendarRequest = Window & {
  model_id?: string;
  platform?: Platform | "auto";
  allow_extrapolation?: boolean;
};
export type CalendarRow = {
  month: string;
  selected_platform: Platform | null;
  raw_by_platform: Partial<Record<Platform, number | null>>; // occupied cell-days, NOT pixel counts
  detection_counts_by_platform: Partial<Record<Platform, number | null>>;
  harmonized_index: number | null;
  excluded_cell_days: number | null;
  flags: string[];
};

export class FireAPI {
  constructor(private base = "http://localhost:8000", private apiKey = "") {}

  private async call(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.apiKey) headers.set("X-API-Key", this.apiKey);
    const response = await fetch(`${this.base}/api/v1${path}`, { ...options, headers });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response;
  }

  private async post(path: string, body: unknown) {
    const response = await this.call(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return response.json();
  }

  async upload(file: File) {
    const body = new FormData();
    body.append("file", file);
    return (await this.call("/datasets/upload", { method: "POST", body })).json();
  }

  async waitForJob(jobId: string, signal?: AbortSignal, timeoutMs = 30 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const job = await (await this.call(`/jobs/${encodeURIComponent(jobId)}`, { signal })).json();
      if (job.status === "succeeded") return job.result;
      if (["failed", "interrupted"].includes(job.status)) throw new Error(job.error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Job is still running; continue polling its status_url");
  }

  calibrate(config: object = {}) { return this.post("/harmonization/calibrate", config); }
  detections(query: Window & { platforms?: Platform[]; limit?: number; offset?: number }) {
    return this.post("/detections/query", query);
  }
  grid(query: Window & { platform?: Platform; limit?: number; offset?: number }) {
    return this.post("/grid/query", query);
  }
  calendar(query: CalendarRequest): Promise<{ rows: CalendarRow[]; meta: object }> {
    return this.post("/analytics/calendar", query);
  }
  seasonality(query: CalendarRequest & { baseline_start_year?: number; baseline_end_year?: number }) {
    return this.post("/analytics/seasonality", query);
  }
  async exportCalendar(query: CalendarRequest): Promise<Blob> {
    return (await this.call("/exports/calendar.csv", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query),
    })).blob();
  }
}

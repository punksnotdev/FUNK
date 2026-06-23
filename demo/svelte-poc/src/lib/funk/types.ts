// Subset of the FUNK radio contract this demo consumes.
//
// `source` is whatever the running stack reports for now-playing. The known
// values today are "schedule" (scheduled programming), "live" (a live source
// connected to harbor), "breaking" (a breaking-news interrupt) and "unknown"
// (radio could not resolve a source). It's typed as a loose union so an
// unfamiliar value from a newer FUNK still parses.
export type NowPlayingSource = "schedule" | "live" | "breaking" | "unknown" | (string & {});

export interface NowPlaying {
  source: NowPlayingSource;
  // Free-form liquidsoap/runtime metadata. `title` is the human-readable
  // now-playing label when present.
  metadata: Record<string, unknown> | null;
}

// One programming entry in the radio schedule. Mirrors FUNK's ScheduleEntry:
// only `audio_url` is required; `title` and `duration_seconds` are optional,
// and `at` (start time) exists in the contract but this demo doesn't set it.
export interface ScheduleEntry {
  audio_url: string;
  at?: string;
  title?: string;
  duration_seconds?: number;
}

// Response of GET /v1/radio/schedule. `applied_at` is null when no schedule
// has ever been applied (the m3u file doesn't exist yet).
export interface ScheduleWindow {
  applied_at: string | null;
  entries: ScheduleEntry[];
}

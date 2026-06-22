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

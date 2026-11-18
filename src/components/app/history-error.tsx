import { AlertTriangle } from "lucide-react";
import { HistoryQueryError, explainFirestoreError } from "@/lib/firebase/db";

/** Shown when stored history (playback, analytics) could not be read, so a failure is never mistaken for "no data". */
export function HistoryError({ error }: { error: unknown }) {
  const e: HistoryQueryError = explainFirestoreError(error);
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1.5">
        <p className="font-medium text-foreground">Could not read stored history</p>
        <p className="text-muted-foreground">{e.message}</p>
        {e.indexUrl && (
          <a
            href={e.indexUrl}
            target="_blank"
            rel="noreferrer"
            className="block break-all text-primary underline"
          >
            Create the index in Firebase
          </a>
        )}
      </div>
    </div>
  );
}

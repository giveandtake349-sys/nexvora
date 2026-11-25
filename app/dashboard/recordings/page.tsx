import { getDashboardData } from "@/lib/dashboard-data";
import { ConfigNotice, PageHeader } from "@/components/ui";
import RecordingsList from "@/components/RecordingsList";

export const dynamic = "force-dynamic";

/**
 * Recordings page — /dashboard/recordings.
 *
 * v1 recordings live ONLY in the viewer's browser (IndexedDB):
 * this page is a shell — the server only checks configuration, the
 * client component reads the browser's own recordings. Nothing is
 * fetched from Postgres, and a recording made in another browser
 * never appears here.
 */
export default async function RecordingsPage() {
  const data = await getDashboardData();
  return (
    <div>
      <PageHeader
        title="Recordings"
        subtitle="Session recordings saved in this browser, newest first."
      />
      {!data.configured && <ConfigNotice />}
      {data.configured && <RecordingsList />}
    </div>
  );
}

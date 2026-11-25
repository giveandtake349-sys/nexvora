import { getDashboardData } from "@/lib/dashboard-data";
import { Card, ConfigNotice, PageHeader } from "@/components/ui";
import { UpdateProfileForm } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const data = await getDashboardData();
  return (
    <div>
      <PageHeader title="Settings" subtitle="Your profile and account." />
      {!data.configured && <ConfigNotice />}
      {data.configured && data.user && (
        <div className="grid max-w-xl gap-4">
          <Card>
            <h2 className="font-semibold text-white">Profile</h2>
            <p className="mt-1 mb-4 text-sm text-[#8FA3A0]">
              Signed in as <span className="text-[#E8F0EE]">{data.user.email}</span>
            </p>
            <UpdateProfileForm currentName={data.user.user_metadata?.display_name ?? ""} />
          </Card>
          <Card>
            <h2 className="font-semibold text-white">Account</h2>
            <p className="mt-2 text-sm text-[#8FA3A0]">
              Email verification and password changes go through Supabase Auth. Use “Forgot password” on the
              sign-in page to reset your password.
            </p>
            <p className="mt-2 text-xs text-[#8FA3A0]">
              User ID: <span className="font-mono">{data.user.id}</span>
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

import { getDashboardData } from "@/lib/dashboard-data";
import { Card, ConfigNotice, PageHeader } from "@/components/ui";
import { UpdateProfileForm } from "@/components/DashboardActions";

export const dynamic = "force-dynamic";

/**
 * Settings — profile and account. Spec Chapter 6 styling: account
 * card (44px avatar with initials, name 15/600, email tertiary),
 * glass cards, radius 20. The web app has no 9-scope settings
 * surface — permissions live on Trusted Devices / Remote Access —
 * so nothing is invented here.
 */
export default async function SettingsPage() {
  const data = await getDashboardData();
  const initials = (data.user?.displayName ?? data.user?.email ?? "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  return (
    <div>
      <PageHeader title="Settings" subtitle="Your profile and account." />
      {!data.configured && <ConfigNotice />}
      {data.configured && data.user && (
        <div className="grid max-w-xl gap-3">
          <Card className="p-3">
            <div className="flex items-center gap-3">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-[#00E5A8]/10 font-display text-[15px] font-semibold text-[#00E5A8]"
                aria-hidden="true"
              >
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[15px] leading-5 font-semibold text-white">
                  {data.user.displayName ?? "NEXVORA user"}
                </p>
                <p className="truncate text-xs text-[rgba(242,247,245,0.38)]">
                  {data.user.email}
                </p>
              </div>
            </div>
          </Card>
          <Card>
            <h2 className="text-xl leading-[26px] font-semibold text-white">Profile</h2>
            <p className="mt-1 mb-4 text-sm text-[#8FA3A0]">
              Signed in as <span className="text-[#F2F7F5]">{data.user.email}</span>
            </p>
            <UpdateProfileForm currentName={data.user.displayName ?? ""} />
          </Card>
          <Card>
            <h2 className="text-xl leading-[26px] font-semibold text-white">Account</h2>
            <p className="mt-2 text-sm text-[#8FA3A0]">
              Email verification and password changes go through Neon Auth. Use “Forgot password” on the
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

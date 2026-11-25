import Link from "next/link";
import { Suspense } from "react";
import AuthLayout from "@/components/AuthLayout";
import { ResetPasswordForm } from "@/components/AuthForms";
import { isAuthConfigured } from "@/lib/db/config";

export default function ResetPasswordPage() {
  const configured = isAuthConfigured();
  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="Use at least 8 characters."
      footer={
        <>
          <Link href="/login" className="font-semibold text-[#00E5A8]">
            Back to sign in
          </Link>
        </>
      }
    >
      <Suspense>
        <ResetPasswordForm configured={configured} />
      </Suspense>
    </AuthLayout>
  );
}

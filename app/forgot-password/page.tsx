import Link from "next/link";
import { Suspense } from "react";
import AuthLayout from "@/components/AuthLayout";
import { ForgotPasswordForm } from "@/components/AuthForms";

export default function ForgotPasswordPage() {
  return (
    <AuthLayout
      title="Reset your password"
      subtitle="We'll email you a secure reset link."
      footer={
        <>
          Remembered it?{" "}
          <Link href="/login" className="font-semibold text-[#00E5A8]">
            Back to sign in
          </Link>
        </>
      }
    >
      <Suspense>
        <ForgotPasswordForm />
      </Suspense>
    </AuthLayout>
  );
}

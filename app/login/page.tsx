import Link from "next/link";
import { Suspense } from "react";
import AuthLayout from "@/components/AuthLayout";
import { LoginForm } from "@/components/AuthForms";
import { isAuthConfigured } from "@/lib/db/config";

export default function LoginPage() {
  const configured = isAuthConfigured();
  return (
    <AuthLayout
      title="Sign in to NEXVORA"
      subtitle="Access your devices, trusted connections and security center."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link href="/register" className="font-semibold text-[#00E5A8]">
            Create one
          </Link>
          {" · "}
          <Link href="/forgot-password" className="font-semibold text-[#00E5A8]">
            Forgot password?
          </Link>
        </>
      }
    >
      <Suspense>
        <LoginForm configured={configured} />
      </Suspense>
    </AuthLayout>
  );
}

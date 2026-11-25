import Link from "next/link";
import { Suspense } from "react";
import AuthLayout from "@/components/AuthLayout";
import { RegisterForm } from "@/components/AuthForms";
import { isAuthConfigured } from "@/lib/db/config";

export default function RegisterPage() {
  const configured = isAuthConfigured();
  return (
    <AuthLayout
      title="Create your NEXVORA account"
      subtitle="One account for every device in your ecosystem."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-[#00E5A8]">
            Sign in
          </Link>
        </>
      }
    >
      <Suspense>
        <RegisterForm configured={configured} />
      </Suspense>
    </AuthLayout>
  );
}

import Link from "next/link";
import { Suspense } from "react";
import AuthLayout from "@/components/AuthLayout";
import { RegisterForm } from "@/components/AuthForms";

export default function RegisterPage() {
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
        <RegisterForm />
      </Suspense>
    </AuthLayout>
  );
}

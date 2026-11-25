import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "./ui";

export default function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#080D12] px-4 py-10">
      <Link href="/">
        <Wordmark />
      </Link>
      <div className="glass mt-8 w-full max-w-md rounded-2xl p-6 sm:p-8">
        <h1 className="text-xl font-bold text-white">{title}</h1>
        <p className="mt-1 text-sm text-[#8FA3A0]">{subtitle}</p>
        <div className="mt-6">{children}</div>
        <div className="mt-6 text-center text-sm text-[#8FA3A0]">{footer}</div>
      </div>
    </div>
  );
}

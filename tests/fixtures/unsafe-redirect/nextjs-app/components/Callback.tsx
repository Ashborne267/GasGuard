"use client";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

export function Callback() {
  const searchParams = useSearchParams();

  useEffect(() => {
    const returnTo = searchParams.get("returnTo");
    if (returnTo) {
      window.location.href = returnTo;
    }
  }, [searchParams]);

  return <p>Signing you in...</p>;
}

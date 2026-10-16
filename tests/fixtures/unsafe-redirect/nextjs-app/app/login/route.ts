import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const next = request.nextUrl.searchParams.get("next");
  // new URL(absolute, base) ignores the base, so this is an open redirect.
  return NextResponse.redirect(new URL(next ?? "/", request.url));
}

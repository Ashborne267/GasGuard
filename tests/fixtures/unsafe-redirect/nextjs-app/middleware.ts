import { NextResponse, type NextRequest } from "next/server";

const ALLOWED_HOSTS = new Set(["app.example.com", "docs.example.com"]);

export function middleware(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get("returnTo");
  if (returnTo) {
    const url = new URL(returnTo, request.url);
    if (!ALLOWED_HOSTS.has(url.host)) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

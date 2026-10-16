const TRUSTED = "https://app.example.com";

export function isAllowedRedirect(redirectUrl: string): boolean {
  // Prefix without a path boundary: https://app.example.com.evil.net passes.
  if (redirectUrl.startsWith("https://app.example.com")) return true;
  // Unanchored regex with an unescaped dot.
  return /https:\/\/docs.example.com/.test(redirectUrl);
}

export function isTrustedHost(returnUrl: string): boolean {
  return returnUrl.includes("example.com");
}

export const trusted = TRUSTED;

export function isValidCallback(callbackUrl: string): boolean {
  const url = new URL(callbackUrl);
  // Suffix without a leading dot: evilexample.com passes.
  if (url.hostname.endsWith("example.com")) return true;
  // Anchored but unterminated: https://example.com.evil.net passes.
  return /^https:\/\/example\.com/.test(callbackUrl);
}

export function isSafeTarget(target: string): boolean {
  return target[0] === "/";
}

const HOST_PATTERN = /^https:\/\/(?:www\.)?example\.com(?:\/|$)/;

export function navigate(returnUrl: string): void {
  if (HOST_PATTERN.test(returnUrl)) {
    window.location.assign(returnUrl);
    return;
  }
  window.location.assign("/");
}

export function goHome(): void {
  window.location.href = "/home";
}

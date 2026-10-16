const express = require("express");
const app = express();

const ALLOWED_ORIGINS = ["https://app.example.com", "https://docs.example.com"];

function isSafeRedirect(value) {
  if (typeof value !== "string") return false;
  // Reject protocol-relative and backslash tricks before the relative check.
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  if (value.startsWith("/")) return true;
  try {
    return ALLOWED_ORIGINS.includes(new URL(value).origin);
  } catch {
    return false;
  }
}

app.get("/login", (req, res) => {
  const next = req.query.next;
  if (!isSafeRedirect(next)) {
    return res.redirect("/");
  }
  res.redirect(next);
});

app.get("/docs", (req, res) => {
  const page = req.query.page;
  res.redirect(`https://docs.example.com/${encodeURIComponent(page)}`);
});

app.get("/home", (_req, res) => {
  // res.redirect(req.query.next) -- commented out, must not be reported
  res.redirect("/dashboard");
});

app.get("/strict", (req, res) => {
  const url = new URL(req.query.target, "https://app.example.com");
  if (url.hostname === "app.example.com") {
    return res.redirect(url.toString());
  }
  res.redirect("/");
});

module.exports = app;

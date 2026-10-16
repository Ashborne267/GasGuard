const express = require("express");
const router = express.Router();

// Open redirect: query parameter flows straight into res.redirect.
router.get("/login/callback", (req, res) => {
  const next = req.query.next;
  res.redirect(next);
});

// Express "back" resolves to the Referer header.
router.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("back");
});

// Status-code form; the target is the last argument.
router.get("/sso", (req, res) => {
  res.redirect(301, req.query.returnTo);
});

// Fixed path prefix: the user value only lands in the query string.
router.get("/signup", (req, res) => {
  res.redirect("/welcome?ref=" + encodeURIComponent(req.query.ref));
});

// Weak relative check: "//evil.example" also starts with "/".
router.get("/continue", (req, res) => {
  const target = req.query.continue;
  if (!target.startsWith("/")) {
    return res.redirect("/");
  }
  res.redirect(target);
});

module.exports = router;

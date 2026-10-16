const { isAllowedRedirect } = require("../utils/redirect");

module.exports = function account(app) {
  // Validated through the shared helper: no finding expected.
  app.get("/account/done", (req, res) => {
    const { returnTo } = req.query;
    if (!isAllowedRedirect(returnTo)) {
      return res.redirect("/account");
    }
    return res.redirect(returnTo);
  });

  // Location header set by hand from a header value.
  app.get("/account/back", (req, res) => {
    res.setHeader("Location", req.get("referer"));
    res.status(302).end();
  });
};

const Koa = require("koa");
const app = new Koa();

app.use(async (ctx) => {
  if (ctx.path === "/go") {
    ctx.redirect(ctx.query.url);
    return;
  }
  ctx.body = "ok";
});

module.exports = app;

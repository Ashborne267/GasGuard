import Fastify from "fastify";

const app = Fastify();

app.get("/oauth/callback", async (request: any, reply: any) => {
  const { state, redirect_uri: redirectUri } = request.query;
  void state;
  return reply.redirect(302, redirectUri);
});

app.get("/health", async (_request: any, reply: any) => {
  return reply.redirect("/status");
});

export default app;

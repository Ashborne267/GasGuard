import http from "node:http";

const BASE = "http://localhost:8080";

http
  .createServer((req, res) => {
    const target = new URL(req.url, BASE).searchParams.get("to");
    res.writeHead(302, { Location: target });
    res.end();
  })
  .listen(8080);

// Tiny HTTP server with an express-like local router (dependency-free so the
// fixture runs anywhere).
import http from "node:http";
import { formatUptime } from "./util.js";

const routes = new Map();
const app = {
  get(routePath, handler) {
    routes.set(`GET ${routePath}`, handler);
  },
};

app.get("/health", (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, uptime: formatUptime(process.uptime()) }));
});

app.get("/version", (req, res) => {
  // TODO: read the version from package.json instead of hardcoding it
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("1.0.0");
});

export function createServer() {
  return http.createServer((req, res) => {
    const handler = routes.get(`${req.method} ${req.url}`);
    if (!handler) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    handler(req, res);
  });
}

// Don't start listening when loaded by a test runner (do-better's own suite
// discovers every .js file under test/ directories).
const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT);
if (!underTestRunner && process.argv[1] && process.argv[1].endsWith("server.js")) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => {
    console.log(`tiny-app listening on :${port}`);
  });
}

// Serves the built blog (dist-blog/) at http://localhost:4180 the way Cloudflare will: /<slug>/ -> index.html,
// unknown paths -> 404.html with status 404. `npm run build:blog && npm run preview:blog`.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";

const dist = resolve(import.meta.dirname, "../../dist-blog");
const port = Number(process.env.PORT ?? 4180);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".xml": "application/xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = resolve(dist, "." + path);
  if (!file.startsWith(dist)) return res.writeHead(400).end();
  try {
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    if (!path.endsWith("/") && !extname(path)) return res.writeHead(301, { location: path + "/" }).end();
    res.writeHead(404, { "content-type": types[".html"] }).end(await readFile(resolve(dist, "404.html")));
  }
}).listen(port, () => console.log(`blog preview: http://localhost:${port}/`));

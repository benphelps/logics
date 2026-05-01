import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { handleHeadshotRequest } from "./headshots.js";
import { handleShipArtRequest } from "./ship-art.js";

const DIST_DIR = resolve(process.cwd(), process.env.LOGICS_DIST_DIR ?? "dist");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Logics production server listening on http://${HOST}:${PORT}`);
  console.log(`Serving static assets from ${DIST_DIR}`);
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (await handleHeadshotRequest(req, res)) return;
    if (await handleShipArtRequest(req, res)) return;
    await serveStatic(req, res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendPlain(res, 500, error instanceof Error ? error.message : "Unexpected production server error.");
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendPlain(res, 405, "Method not allowed.");
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const routePath = routeToFilePath(url.pathname);
  const filePath = resolve(DIST_DIR, `.${routePath}`);

  if (!isInsideDist(filePath)) {
    sendPlain(res, 403, "Forbidden.");
    return;
  }

  const file = await findStaticFile(filePath, url.pathname, req.headers.accept ?? "");
  if (!file) {
    sendPlain(res, 404, "Not found.");
    return;
  }

  const fileStat = await stat(file);
  const ext = extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", fileStat.size);
  res.setHeader("Cache-Control", cacheControlFor(file));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).on("error", () => {
    if (!res.headersSent) sendPlain(res, 404, "Not found.");
    else res.destroy();
  }).pipe(res);
}

function routeToFilePath(pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  if (decoded === "/") return "/index.html";
  if (decoded === "/website") return "/website.html";
  if (decoded === "/wiki") return "/wiki.html";
  return decoded;
}

async function findStaticFile(filePath: string, pathname: string, accept: string): Promise<string | null> {
  const direct = await stat(filePath).catch(() => null);
  if (direct?.isFile()) return filePath;

  if (direct?.isDirectory()) {
    const indexPath = resolve(filePath, "index.html");
    const indexStat = await stat(indexPath).catch(() => null);
    if (indexStat?.isFile() && isInsideDist(indexPath)) return indexPath;
  }

  const wantsHtml = accept.includes("text/html") || accept.includes("*/*");
  if (!extname(pathname) && wantsHtml) return resolve(DIST_DIR, "index.html");
  return null;
}

function isInsideDist(filePath: string): boolean {
  const relative = filePath.slice(DIST_DIR.length);
  return filePath === DIST_DIR || (filePath.startsWith(DIST_DIR) && relative.startsWith(sep));
}

function cacheControlFor(filePath: string): string {
  return filePath.includes(`${sep}assets${sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function sendPlain(res: ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

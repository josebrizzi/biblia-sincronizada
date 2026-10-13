const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8090;
const CODIGO_ACCESO = String(process.env.CODIGO_ACCESO || "").trim();
if (!CODIGO_ACCESO) {
  console.log("AVISO: CODIGO_ACCESO no definida en Render — la app está abierta (sin código).");
}

const db = new sqlite3.Database(
  path.join(__dirname, "biblia.db"),
  (err) => {
    if (err) console.error("Error al abrir la base de datos:", err.message);
    else console.log("Base de datos de la Biblia conectada.");
  }
);

// ---- Páginas ----
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/admin.html", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/proyeccion.html", (req, res) => res.sendFile(path.join(__dirname, "proyeccion.html")));
app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "manifest.json")));
app.get("/icono.svg", (req, res) => res.sendFile(path.join(__dirname, "icono.svg")));

// ---- API de la Biblia ----
app.get("/api/versions", (req, res) => {
  db.all("SELECT DISTINCT version FROM verses ORDER BY version", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map((row) => row.version));
  });
});

app.get("/api/books", (req, res) => {
  const version = req.query.version;
  if (!version) return res.status(400).json({ error: "Falta la versión." });
  db.all(
    "SELECT DISTINCT book_number, book_name FROM verses WHERE version = ? ORDER BY book_number",
    [version],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get("/api/chapters", (req, res) => {
  const version = req.query.version;
  const bookNumber = Number(req.query.book);
  if (!version || !bookNumber) return res.status(400).json({ error: "Faltan parámetros." });
  db.all(
    "SELECT DISTINCT chapter FROM verses WHERE version = ? AND book_number = ? ORDER BY chapter",
    [version, bookNumber],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map((row) => row.chapter));
    }
  );
});

app.get("/api/verses", (req, res) => {
  const version = req.query.version;
  const bookNumber = Number(req.query.book);
  const chapter = Number(req.query.chapter);
  if (!version || !bookNumber || !chapter) return res.status(400).json({ error: "Faltan parámetros." });
  db.all(
    "SELECT verse, text FROM verses WHERE version = ? AND book_number = ? AND chapter = ? ORDER BY verse",
    [version, bookNumber, chapter],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ---- Buscador ----
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  const version = String(req.query.version || "");
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  if (!q) return res.status(400).json({ error: "Falta el parámetro q" });
  if (!version) return res.status(400).json({ error: "Falta la versión." });

  const seguro = q.replace(/[\\%_]/g, (m) => "\\" + m);
  const like = "%" + seguro + "%";

  db.all(
    `SELECT book_number, book_name, chapter, verse, text
     FROM verses
     WHERE version = ? AND text LIKE ? ESCAPE '\\'
     ORDER BY book_number, chapter, verse
     LIMIT ?`,
    [version, like, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ---- WebSocket ----
function broadcastCount() {
  let n = 0;
  wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) n++; });
  const msg = JSON.stringify({ type: "connected", count: n });
  wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.autorizado = false;
  ws.on("pong", () => { ws.isAlive = true; });
  broadcastCount();

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Autenticación por código (solo si CODIGO_ACCESO está definida en Render)
      if (data.type === "auth") {
        if (!CODIGO_ACCESO) {
          ws.autorizado = true;
          ws.send(JSON.stringify({ type: "auth-ok", abierto: true }));
          return;
        }
        if (String(data.codigo || "").trim() === CODIGO_ACCESO) {
          ws.autorizado = true;
          ws.send(JSON.stringify({ type: "auth-ok" }));
        } else {
          ws.autorizado = false;
          ws.send(JSON.stringify({ type: "auth-error" }));
        }
        return;
      }

      if (data.type === "project" && data.data) {
        const t = data.data.type;
        // El contenido (versículos y citas) exige código; lo demás (sincronía de partes, fondo) pasa libre
        const necesitaAuth = (t === "verse" || t === "freeText");
        if (necesitaAuth && CODIGO_ACCESO && !ws.autorizado) return;

        const out = JSON.stringify({ type: "projection", data: data.data });
        wss.clients.forEach((c) => {
          if (c.readyState === WebSocket.OPEN) c.send(out);
        });
      }
    } catch (e) { /* mensaje inválido: ignorar */ }
  });

  ws.on("close", () => broadcastCount());
});

setInterval(() => {
  wss.clients.forEach((c) => {
    if (!c.isAlive) return c.terminate();
    c.isAlive = false;
    c.ping();
  });
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("BIBLIA SINCRONIZADA — Servidor iniciado en puerto " + PORT);
});

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_CARDS = 200;

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function emptyState() {
  return { cards: [] };
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!data || !Array.isArray(data.cards)) return emptyState();
    data.cards = data.cards.filter((card) => {
      return card && typeof card.id === "string" && typeof card.file === "string" && fileExists(card.file);
    });
    return data;
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Estado ilegível, começando vazio:", err.message);
    return emptyState();
  }
}

function fileExists(filename) {
  const filePath = safeUploadPath(filename);
  return Boolean(filePath) && fs.existsSync(filePath);
}

function safeUploadPath(filename) {
  const base = path.basename(String(filename || ""));
  if (!base || base !== filename) return null;
  const filePath = path.resolve(UPLOAD_DIR, base);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null;
  return filePath;
}

let state = loadState();
let queue = Promise.resolve();

function mutate(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function persist() {
  const tmp = STATE_PATH + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(state));
  await fs.promises.rename(tmp, STATE_PATH);
}

async function commit(change) {
  const backup = JSON.stringify(state);
  change();
  try {
    await persist();
  } catch (err) {
    state = JSON.parse(backup);
    throw err;
  }
}

function snapshot() {
  return {
    cards: state.cards.map((card) => ({
      id: card.id,
      url: "/media/" + card.id,
      done: Boolean(card.done),
    })),
  };
}

function passwordMatches(given) {
  const a = crypto.createHash("sha256").update(String(given), "utf8").digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return true;
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && passwordMatches(token);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: "Senha necessária para alterar as cartas" });
}

async function removeStoredFile(filename) {
  const filePath = safeUploadPath(filename);
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = MIME_EXT[file.mimetype] || "";
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: MAX_BYTES, files: 30 },
  fileFilter: (req, file, cb) => {
    if (MIME_EXT[file.mimetype]) cb(null, true);
    else cb(new Error("Envie apenas JPEG, PNG, WEBP ou GIF"));
  },
});

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  next();
});
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  res.json({
    adminRequired: Boolean(ADMIN_PASSWORD),
    admin: isAdmin(req),
  });
});

app.get("/api/cards", (req, res) => {
  res.json(snapshot());
});

app.get("/media/:id", (req, res) => {
  const card = state.cards.find((item) => item.id === req.params.id);
  if (!card) return res.status(404).end();
  const filePath = safeUploadPath(card.file);
  if (!filePath) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.post("/api/cards", requireAdmin, (req, res, next) => {
  upload.array("images", 30)(req, res, (err) => {
    if (err) return next(err);
    const files = req.files || [];
    mutate(async () => {
      if (!files.length) {
        res.status(400).json({ error: "Nenhuma imagem enviada" });
        return;
      }
      const room = MAX_CARDS - state.cards.length;
      if (room <= 0) {
        await Promise.all(files.map((file) => removeStoredFile(file.filename)));
        res.status(400).json({ error: "Limite de " + MAX_CARDS + " cartas atingido" });
        return;
      }
      const accepted = files.slice(0, room);
      const rejected = files.slice(room);
      await Promise.all(rejected.map((file) => removeStoredFile(file.filename)));
      try {
        await commit(() => {
          for (const file of accepted) {
            state.cards.push({
              id: crypto.randomUUID(),
              file: file.filename,
              done: false,
            });
          }
        });
      } catch (err) {
        await Promise.all(accepted.map((file) => removeStoredFile(file.filename)));
        throw err;
      }
      res.json(snapshot());
    }).catch(next);
  });
});

app.post("/api/cards/shuffle", requireAdmin, (req, res, next) => {
  mutate(async () => {
    await commit(() => {
      for (let i = state.cards.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const swap = state.cards[i];
        state.cards[i] = state.cards[j];
        state.cards[j] = swap;
      }
    });
    res.json(snapshot());
  }).catch(next);
});

app.post("/api/cards/reset", requireAdmin, (req, res, next) => {
  mutate(async () => {
    await commit(() => {
      state.cards.forEach((card) => {
        card.done = false;
      });
    });
    res.json(snapshot());
  }).catch(next);
});

app.post("/api/cards/:id/reveal", (req, res, next) => {
  mutate(async () => {
    const card = state.cards.find((item) => item.id === req.params.id);
    if (!card) {
      res.status(404).json({ error: "Carta não encontrada" });
      return;
    }
    await commit(() => {
      card.done = true;
    });
    res.json(snapshot());
  }).catch(next);
});

app.delete("/api/cards", requireAdmin, (req, res, next) => {
  mutate(async () => {
    const files = state.cards.map((card) => card.file);
    await commit(() => {
      state.cards = [];
    });
    await Promise.all(files.map((file) => removeStoredFile(file)));
    res.json(snapshot());
  }).catch(next);
});

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const multerError = err instanceof multer.MulterError || (err && err.message === "Envie apenas JPEG, PNG, WEBP ou GIF");
  if (multerError) {
    Promise.all((req.files || []).map((file) => removeStoredFile(file.filename))).catch(() => {});
  } else {
    console.error(err);
  }
  const tooBig = err && err.code === "LIMIT_FILE_SIZE";
  const tooMany = err && (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE");
  const message = tooBig
    ? "Cada imagem pode ter no máximo 10 MB"
    : tooMany
      ? "Envie no máximo 30 imagens por vez"
      : multerError
        ? err.message
        : "Erro interno";
  res.status(multerError ? 400 : 500).json({ error: message });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Revelação de cartas em http://0.0.0.0:" + PORT);
  console.log("Imagens em " + UPLOAD_DIR);
});

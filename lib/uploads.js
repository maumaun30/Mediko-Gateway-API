// Moved verbatim from index.js.
const crypto = require("crypto");
const fs = require("fs");
const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (_req, file, cb) =>
    cb(null, `ID-${Date.now()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

const returnsStorage = multer.diskStorage({
  destination: "./uploads/",
  filename: (_req, file, cb) =>
    cb(null, `RET-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${path.extname(file.originalname)}`),
});

const returnsUpload = multer({
  storage: returnsStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

// Posts the file to the optimizer service, polls until ready, downloads the
// converted bytes, writes them next to the original (with a .webp extension by
// default), then deletes the original. Returns the new on-disk path. Callers
// should fall back to the original path on throw.
async function optimizeImage(filePath, { format = "webp", width = 1200 } = {}) {
  const baseUrl = process.env.IMAGE_OPTIMIZER_URL;
  if (!baseUrl) throw new Error("IMAGE_OPTIMIZER_URL not set");

  const fileBuffer = await fs.promises.readFile(filePath);
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append("files", new Blob([fileBuffer]), filename);
  const uploadRes = await fetch(
    `${baseUrl}/images/upload?format=${format}&width=${width}`,
    { method: "POST", body: form },
  );
  if (!uploadRes.ok) throw new Error(`upload ${uploadRes.status}`);
  const { jobs } = await uploadRes.json();
  const jobId = jobs[0].id;

  const pollStart = Date.now();
  while (true) {
    if (Date.now() - pollStart > 60_000) throw new Error("poll timeout");
    await new Promise((r) => setTimeout(r, 1500));
    const s = await fetch(`${baseUrl}/images/status/${jobId}`);
    if (!s.ok) throw new Error(`status ${s.status}`);
    const job = await s.json();
    if (job.status === "ready") break;
    if (job.status === "failed" || job.status === "expired") {
      throw new Error(`job ${job.status}: ${job.error_message || ""}`);
    }
  }

  const dl = await fetch(`${baseUrl}/images/download/${jobId}`);
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());

  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const newPath = path.join(dir, `${stem}.${format}`);
  await fs.promises.writeFile(newPath, buf);
  if (newPath !== filePath) {
    await fs.promises.unlink(filePath).catch(() => {});
  }
  return newPath;
}

module.exports = { optimizeImage, returnsStorage, returnsUpload, storage, upload };

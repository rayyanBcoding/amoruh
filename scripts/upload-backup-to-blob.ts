// One-time: uploads the pre-migration backup files to Vercel Blob —
// this app's existing, already-used-for-real-commercial-data storage
// (the same place supplier price-list uploads themselves live) — so a
// local machine failure can't eliminate the only copy. Never commits
// anything to git; BLOB_READ_WRITE_TOKEN is read from the environment
// only, never printed.
import fs from "fs";
import path from "path";
import { put } from "@vercel/blob";

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: npx tsx scripts/upload-backup-to-blob.ts <file1> <file2> ...");
    process.exit(1);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN not set in the environment.");
    process.exit(1);
  }
  for (const filePath of files) {
    const buffer = fs.readFileSync(filePath);
    const filename = `migration-backups/${path.basename(filePath)}`;
    const blob = await put(filename, buffer, { access: "public", addRandomSuffix: true });
    console.log(`Uploaded ${filePath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB) -> ${blob.url}`);
  }
}
main();

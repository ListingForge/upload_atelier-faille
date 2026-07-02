// Watches data/mockups/ and data/mockup-lists.json locally and rsyncs to the
// server whenever they change. Debounced so bursts of file operations produce
// one sync. Meant to run in the background while you edit mockups locally.
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MOCKUPS = path.join(ROOT, "data", "mockups");
const INDEX = path.join(ROOT, "data", "mockup-lists.json");

const HOST = process.env.DEPLOY_HOST ?? "178.105.133.152";
const USER = process.env.DEPLOY_USER ?? "ben";
const REMOTE_PATH = process.env.DEPLOY_PATH ?? "/home/ben/upload-atelier-faille";

if (!existsSync(MOCKUPS)) mkdirSync(MOCKUPS, { recursive: true });

let syncing = false;
let pending = false;

function sync() {
  if (syncing) { pending = true; return; }
  syncing = true;
  console.log(`[${new Date().toLocaleTimeString()}] → sync`);
  const args = [
    "-az", "--delete",
    `${MOCKUPS}/`,
    `${USER}@${HOST}:${REMOTE_PATH}/data/mockups/`,
  ];
  const proc = spawn("rsync", args, { stdio: "inherit" });
  proc.on("exit", code => {
    syncing = false;
    if (code === 0) console.log(`[${new Date().toLocaleTimeString()}] ✓ synced`);
    else console.log(`[${new Date().toLocaleTimeString()}] ✗ rsync exit ${code}`);
    if (pending) { pending = false; setTimeout(sync, 500); }
  });
}

let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(sync, 800);
}

console.log(`watching ${MOCKUPS}`);
console.log(`target ${USER}@${HOST}:${REMOTE_PATH}/data/mockups/`);

watch(MOCKUPS, { recursive: true }, () => schedule());
if (existsSync(INDEX)) watch(INDEX, () => schedule());

// initial sync so state is always fresh when the watcher starts
schedule();

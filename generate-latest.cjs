const fs = require("fs");
const path = require("path");

const REPO = process.env.GITHUB_REPOSITORY || "FURSOY/mail";
const PLATFORM = "windows-x86_64";

const rootDir = __dirname;
const packageJsonPath = path.join(rootDir, "package.json");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const nsisDir = path.join(rootDir, "src-tauri", "target", "release", "bundle", "nsis");
const latestJsonPath = path.join(rootDir, "latest.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function decodeSignatureComment(signature) {
  try {
    return Buffer.from(signature.trim(), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function findArtifact(files, version) {
  const expectedName = `FURSOY Mail_${version}_x64-setup.exe`;
  if (files.includes(expectedName)) return expectedName;

  const matches = files.filter((name) =>
    name.endsWith(".exe") &&
    name.includes(`_${version}_`) &&
    name.toLowerCase().includes("setup")
  );

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(`Multiple NSIS installers match v${version}: ${matches.join(", ")}`);
  }

  fail(`NSIS installer for v${version} was not found in ${nsisDir}. Run "npm run tauri build" first.`);
}

const packageData = readJson(packageJsonPath);
const tauriConfig = readJson(tauriConfigPath);
const version = packageData.version;

if (!version) fail("package.json does not contain a version.");
if (tauriConfig.version !== version) {
  fail(`Version mismatch: package.json is ${version}, tauri.conf.json is ${tauriConfig.version}.`);
}

if (!fs.existsSync(nsisDir)) {
  fail(`NSIS bundle directory does not exist: ${nsisDir}`);
}

const files = fs.readdirSync(nsisDir);
const exeFile = findArtifact(files, version);
const sigFile = `${exeFile}.sig`;
const exePath = path.join(nsisDir, exeFile);
const sigPath = path.join(nsisDir, sigFile);

if (!fs.existsSync(sigPath)) {
  fail(`Signature file is missing for ${exeFile}: ${sigFile}`);
}

const signature = fs.readFileSync(sigPath, "utf8").trim();
const decodedSignature = decodeSignatureComment(signature);

if (!decodedSignature.includes(`file:${exeFile}`)) {
  fail(`Signature file does not belong to ${exeFile}. Rebuild updater artifacts before generating latest.json.`);
}

const latestJson = {
  version,
  notes: "Stability, updater, mail rendering, and performance improvements.",
  pub_date: new Date().toISOString(),
  platforms: {
    [PLATFORM]: {
      signature,
      url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(exeFile)}`,
    },
  },
};

fs.writeFileSync(latestJsonPath, `${JSON.stringify(latestJson, null, 2)}\n`);

console.log(`latest.json generated for v${version}`);
console.log(`Artifact: ${exePath}`);
console.log(`Signature: ${sigPath}`);
console.log(`URL: ${latestJson.platforms[PLATFORM].url}`);

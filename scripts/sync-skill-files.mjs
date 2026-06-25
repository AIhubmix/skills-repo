// scripts/sync-skill-files.mjs
// Fetches skill files from source repositories into the configured cache directory
// Run this before build-registry.mjs to populate skill content

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fg from "fast-glob";
import YAML from "yaml";
import { loadConfig, getBuildConfig } from "./lib/config.mjs";
import { safeResolveSymlink } from "./lib/safe-symlink.mjs";

const SKILL_YAML_GLOB = "skills/*/*/.x_skill.yaml";

const SKILL_FILE_IGNORE = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "out",
  "__pycache__",
  ".DS_Store",
  ".x_skill.yaml",
  "skill.yaml"
];

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readYamlFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return YAML.parse(raw);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}\n${res.stderr || ""}`);
  }
  return res.stdout;
}

async function copyDirFiltered(srcDir, destDir, ignore = [], repoRoot = null) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  // Resolve repoRoot to handle symlinked paths (e.g., /tmp -> /private/tmp on macOS)
  const resolvedRoot = repoRoot ? await fs.realpath(repoRoot) : null;

  for (const e of entries) {
    // Skip ignored patterns
    if (ignore.includes(e.name)) continue;

    const src = path.join(srcDir, e.name);
    const dest = path.join(destDir, e.name);

    const st = await fs.lstat(src);

    if (st.isSymbolicLink()) {
      // Use safe symlink resolution to prevent TOCTOU attacks
      const allowedRoot = resolvedRoot || repoRoot;
      if (!allowedRoot) {
        console.warn(`  ⚠️  Cannot verify symlink safety (no repo root): ${e.name}`);
        continue;
      }
      const resolved = await safeResolveSymlink(src, allowedRoot);

      if (!resolved) {
        // safeResolveSymlink already logged the warning
        continue;
      }

      const { realPath, stat: targetStat } = resolved;

      if (targetStat.isDirectory()) {
        console.log(`  📁 Resolving symlink dir: ${e.name} -> ${realPath}`);
        await copyDirFiltered(realPath, dest, ignore, repoRoot);
      } else if (targetStat.isFile()) {
        console.log(`  📄 Resolving symlink file: ${e.name} -> ${realPath}`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(realPath, dest);
      }
      continue;
    }

    if (st.isDirectory()) {
      await copyDirFiltered(src, dest, ignore, repoRoot);
      continue;
    }

    if (!st.isFile()) continue;

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

// Result shape: 'synced' (ok / cached) | 'gone' (upstream path no longer exists, safe to auto-remove)
//              | 'failed' (network/clone/copy error — keep metadata, surface as error)
async function syncSkill(skillId, source, cacheDir) {
  const { repo, path: sourcePath, ref } = source;

  if (!repo || !ref) {
    console.log(`  ⚠️  Skipping ${skillId}: missing source.repo or source.ref`);
    return { status: "failed", reason: "missing source.repo or source.ref" };
  }

  const skillCacheDir = path.join(cacheDir, skillId);

  // Check if already cached with same ref
  const cacheMetaPath = path.join(skillCacheDir, ".cache-meta.json");
  if (await pathExists(cacheMetaPath)) {
    try {
      const cacheMeta = JSON.parse(await fs.readFile(cacheMetaPath, "utf8"));
      if (cacheMeta.repo === repo && cacheMeta.ref === ref && cacheMeta.path === sourcePath) {
        console.log(`  ✓ ${skillId} (cached)`);
        return { status: "synced" };
      }
    } catch {
      // Invalid cache, will re-fetch
    }
  }

  console.log(`  ↓ ${skillId} from ${repo}@${ref}`);

  // Clone to temp directory
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `skill-sync-${skillId}-`));
  const repoDir = path.join(tmp, "repo");

  try {
    // Try shallow clone first
    try {
      run("git", ["clone", "--depth", "1", "--branch", ref, repo, repoDir], { stdio: "pipe" });
    } catch {
      // Fallback to full clone + checkout
      run("git", ["clone", repo, repoDir], { stdio: "pipe" });
      run("git", ["-C", repoDir, "checkout", ref], { stdio: "pipe" });
    }

    // Determine source directory
    const srcSkillDir = sourcePath && sourcePath !== "."
      ? path.join(repoDir, sourcePath)
      : repoDir;

    if (!(await pathExists(srcSkillDir))) {
      // Repo + ref were reachable but the specific sub-path is gone.
      // Treat as upstream removal/rename — caller will auto-remove our metadata.
      console.warn(`    🗑️  upstream gone: path "${sourcePath}" missing at ${repo}@${ref}`);
      return { status: "gone", reason: `Source path not found: ${sourcePath}` };
    }

    // Clean existing cache
    if (await pathExists(skillCacheDir)) {
      await fs.rm(skillCacheDir, { recursive: true });
    }

    // Copy files to cache (pass repoDir as root for symlink resolution)
    await copyDirFiltered(srcSkillDir, skillCacheDir, SKILL_FILE_IGNORE, repoDir);

    // Write cache metadata
    await fs.writeFile(cacheMetaPath, JSON.stringify({
      repo,
      ref,
      path: sourcePath,
      syncedAt: new Date().toISOString()
    }, null, 2));

    console.log(`    ✓ synced`);
    return { status: "synced" };
  } catch (err) {
    console.error(`    ✗ failed: ${err.message}`);
    return { status: "failed", reason: err.message };
  } finally {
    // Clean up temp directory
    try {
      await fs.rm(tmp, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Remove on-disk metadata + skill dir for an upstream-gone skill.
 * Keeps the category dir (it carries _category.yaml + sibling skills).
 */
async function removeGoneSkill({ yamlPath, id, cacheDir }) {
  const skillDir = path.dirname(yamlPath);
  await fs.rm(skillDir, { recursive: true, force: true });
  // Best-effort: also clean cache so a stale entry can't reappear
  await fs.rm(path.join(cacheDir, id), { recursive: true, force: true });
}

async function main() {
  console.log("🔄 Syncing skill files from source repositories...\n");

  // Load config to get cache directory
  const config = await loadConfig();
  const buildConfig = getBuildConfig(config);
  const CACHE_DIR = buildConfig.cacheDir;

  // Find all skill metadata files
  const skillYamlPaths = await fg([SKILL_YAML_GLOB], { onlyFiles: true, dot: true });
  skillYamlPaths.sort((a, b) => a.localeCompare(b));

  if (skillYamlPaths.length === 0) {
    console.log("No skills found to sync.\n");
    return;
  }

  console.log(`Found ${skillYamlPaths.length} skill(s) to sync:\n`);

  // Ensure cache directory exists
  await fs.mkdir(CACHE_DIR, { recursive: true });

  let synced = 0;
  let failed = 0;
  let skipped = 0;
  const gone = []; // { yamlPath, id, reason }

  for (const yamlPath of skillYamlPaths) {
    try {
      const meta = await readYamlFile(yamlPath);

      if (!meta.source) {
        console.log(`  ⚠️  ${meta.id || yamlPath}: no source info, skipping`);
        skipped++;
        continue;
      }

      const result = await syncSkill(meta.id, meta.source, CACHE_DIR);
      if (result.status === "synced") {
        synced++;
      } else if (result.status === "gone") {
        gone.push({ yamlPath, id: meta.id, reason: result.reason });
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ ${yamlPath}: ${err.message}`);
      failed++;
    }
  }

  // Auto-remove skills whose upstream path no longer exists.
  // Only triggers when clone+ref succeeded but the sub-path is missing —
  // network/clone errors hit the 'failed' branch and never reach here.
  if (gone.length > 0) {
    console.log(`\n🗑️  Auto-removing ${gone.length} skill(s) whose upstream paths no longer exist:`);
    for (const g of gone) {
      console.log(`   - ${g.id}  (${path.dirname(g.yamlPath)})`);
      console.log(`       reason: ${g.reason}`);
      try {
        await removeGoneSkill({ yamlPath: g.yamlPath, id: g.id, cacheDir: CACHE_DIR });
      } catch (err) {
        console.error(`       ✗ remove failed: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\n✅ Sync complete!`);
  console.log(`   Synced: ${synced}`);
  console.log(`   Auto-removed: ${gone.length}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Cache: ${CACHE_DIR}/\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

await main();

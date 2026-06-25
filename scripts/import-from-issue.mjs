// scripts/import-from-issue.mjs (v2 - metadata only)
// This script only creates .x_skill.yaml metadata files.
// Actual skill files are fetched during build by sync-skill-files.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import fg from "fast-glob";
import YAML from "yaml";
import { MAX_ITEMS_PER_IMPORT } from './lib/constants.mjs';
import { assertSlug } from '../cli/lib/validation.mjs';

// Parse SKILL.md frontmatter (YAML between --- markers)
function parseSkillMdFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) return {};

  const frontmatter = lines.slice(1, endIndex).join("\n");
  const result = {};

  const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m);

  if (titleMatch) result.title = titleMatch[1];
  if (descMatch) result.description = descMatch[1];

  return result;
}

// Extract first paragraph as description (after frontmatter and title)
function extractDescriptionFromMarkdown(content) {
  // Strip frontmatter
  let md = content;
  if (md.startsWith("---\n") || md.startsWith("---\r\n")) {
    const end = md.search(/\r?\n---\r?\n/);
    if (end !== -1) {
      const matchLen = md.slice(end).match(/\r?\n---\r?\n/)[0].length;
      md = md.slice(end + matchLen);
    }
  }

  md = md.trim();
  if (!md) return "";

  const lines = md.split("\n");

  // Skip leading title (# ...)
  if (lines[0]?.startsWith("#")) {
    lines.shift();
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  }

  // Get first paragraph
  const para = [];
  for (const line of lines) {
    if (line.trim() === "") break;
    para.push(line);
  }

  const text = para.join(" ").trim();
  return text;
}

function run(cmd, args, opts = {}) {
  let res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}`);
}

function extractImportBlock(issueBody) {
  let marker = "<!-- skillhub-import:v2";
  let start = issueBody.indexOf(marker);
  // Fallback to v1 for backward compatibility
  if (start === -1) {
    marker = "<!-- skillhub-import:v1";
    start = issueBody.indexOf(marker);
  }
  if (start === -1) throw new Error("Missing import block marker: <!-- skillhub-import:v2 (or v1)");
  let end = issueBody.indexOf("-->", start);
  if (end === -1) throw new Error("Missing import block terminator: -->");
  let inner = issueBody.slice(start + marker.length, end).trim();
  if (!inner) throw new Error("Empty import block");
  return inner;
}

function normalizeSourcePath(p) {
  if (typeof p !== "string" || p.length === 0) return ".";

  // Normalize path separators
  let v = p.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!v) return ".";

  // Block multiple traversal techniques:
  // - Direct: ".."
  // - Encoded: "%2e%2e", "..%2f"
  // - Double: "...."
  // - Mixed: "./.."
  const dangerous = [
    /\.\./,           // any ".." sequence
    /%2e%2e/i,        // URL encoded ..
    /%252e/i,         // double encoded
    /\.%2f/i,         // mixed encoding
    /\/{2,}/,         // multiple slashes (could hide ..)
  ];

  for (const pattern of dangerous) {
    if (pattern.test(v)) {
      throw new Error(`Invalid sourcePath (traversal attempt detected): ${p}`);
    }
  }

  // Additional safety: ensure path doesn't start with /
  if (v.startsWith('/')) {
    throw new Error(`Invalid sourcePath (absolute paths not allowed): ${p}`);
  }

  return v;
}

function parseRequest(issueBody) {
  let yamlText = extractImportBlock(issueBody);
  let req = YAML.parse(yamlText);

  if (!req || typeof req !== "object") throw new Error("Import block is not a YAML object");
  if (typeof req.sourceRepo !== "string" || !req.sourceRepo.startsWith("https://github.com/")) {
    throw new Error(`sourceRepo must be a https://github.com/... URL. Got: ${String(req.sourceRepo)}`);
  }
  if (typeof req.ref !== "string" || !req.ref.trim()) throw new Error("ref is required");

  // Git refs can be:
  // - Branch names: main, feature/foo, dev-branch
  // - Tags: v1.0.0, release-2024
  // - Commit SHAs: abc123def (hex chars)
  // NOT allowed: --options, special chars that could break commands
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(req.ref)) {
    throw new Error(`ref contains invalid characters or format: ${req.ref}`);
  }

  // Prevent git option injection (refs starting with -)
  if (req.ref.startsWith('-')) {
    throw new Error(`ref cannot start with '-': ${req.ref}`);
  }

  // Prevent refs that could be confused with options or dangerous patterns
  const dangerousPatterns = [
    /^-/,              // starts with dash (git option)
    /\.\./,            // path traversal in ref
    /^\.$/,            // current dir
    /^~$/,             // home dir
    /[\x00-\x1f\x7f]/, // control characters
    /[<>"|*?]/,        // shell special chars
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(req.ref)) {
      throw new Error(`ref contains dangerous pattern: ${req.ref}`);
    }
  }
  if (!Array.isArray(req.items) || req.items.length === 0) throw new Error("items must be a non-empty list");
  if (req.items.length > MAX_ITEMS_PER_IMPORT) {
    throw new Error(`Too many items (max ${MAX_ITEMS_PER_IMPORT} per request)`);
  }

  let items = req.items.map((it, idx) => {
    if (!it || typeof it !== "object") throw new Error(`items[${idx}] must be an object`);

    let sourcePath = normalizeSourcePath(it.sourcePath ?? ".");
    let targetCategory = it.targetCategory;
    assertSlug(`items[${idx}].targetCategory`, targetCategory);

    // Required fields for .x_skill.yaml generation
    let id = typeof it.id === "string" ? it.id.trim() : undefined;
    if (!id) throw new Error(`items[${idx}].id is required`);
    assertSlug(`items[${idx}].id`, id);

    let title = typeof it.title === "string" ? it.title.trim() : id;

    // Optional fields
    let tags = Array.isArray(it.tags) ? it.tags.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()) : [];
    let isUpdate = it.isUpdate === true || it.isUpdate === "true";

    return { sourcePath, targetCategory, id, title, tags, isUpdate };
  });

  return {
    sourceRepo: req.sourceRepo,
    ref: req.ref,
    items
  };
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let issueBody = process.env.ISSUE_BODY ?? "";
  if (!issueBody.trim()) throw new Error("ISSUE_BODY is empty (workflow must pass github.event.issue.body)");

  let req = parseRequest(issueBody);

  let tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-import-"));
  let srcRepoDir = path.join(tmp, "source");

  try {
    console.log(`Cloning ${req.sourceRepo} @ ${req.ref}`);
    try {
      run("git", ["clone", "--depth", "1", "--branch", req.ref, req.sourceRepo, srcRepoDir]);
    } catch {
      run("git", ["clone", req.sourceRepo, srcRepoDir]);
      run("git", ["-C", srcRepoDir, "checkout", req.ref]);
    }

    let commitSha = spawnSync("git", ["-C", srcRepoDir, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (commitSha.status !== 0) throw new Error("Failed to resolve source commit SHA");
    let commit = (commitSha.stdout ?? "").trim();

    let imported = [];

    for (let item of req.items) {
      let srcSkillDir = item.sourcePath === "." ? srcRepoDir : path.join(srcRepoDir, item.sourcePath);
      let srcSkillMd = path.join(srcSkillDir, "SKILL.md");

      // Only require SKILL.md to exist
      if (!(await pathExists(srcSkillMd))) {
        throw new Error(`Missing SKILL.md at sourcePath: ${item.sourcePath}`);
      }

      // Read SKILL.md and extract description
      let skillMdContent = await fs.readFile(srcSkillMd, "utf8");
      let frontmatter = parseSkillMdFrontmatter(skillMdContent);
      let description = frontmatter.description || extractDescriptionFromMarkdown(skillMdContent);
      if (!description) {
        description = item.title; // Fallback to title if no description found
      }

      let destSkillDir = path.join("skills", item.targetCategory, item.id);

      // If updating, find and remove any existing skill with the same ID (even in different category)
      if (item.isUpdate) {
        // Use fast-glob to find all skills with matching ID (v2: no subcategory)
        const existingSkills = await fg([`skills/*/${item.id}/.x_skill.yaml`], { onlyFiles: true, dot: true });

        for (const existingPath of existingSkills) {
          const existingDir = existingPath.replace(/\/.x_skill\.yaml$/, "");

          // Only remove if it's different from the destination
          if (existingDir !== destSkillDir) {
            console.log(`Removing old skill location: ${existingDir}`);
            await fs.rm(existingDir, { recursive: true });
          }
        }

        // Also remove destination if it exists
        if (await pathExists(destSkillDir)) {
          console.log(`Updating existing skill: ${destSkillDir}`);
          await fs.rm(destSkillDir, { recursive: true });
        }
      } else {
        // For new skills, check if destination already exists
        if (await pathExists(destSkillDir)) {
          throw new Error(`Destination already exists: ${destSkillDir}. Set isUpdate: true to update.`);
        }

        // Also check if this ID exists anywhere else
        const existingSkills = await fg([`skills/*/${item.id}/.x_skill.yaml`], { onlyFiles: true, dot: true });
        if (existingSkills.length > 0) {
          throw new Error(`Skill with ID "${item.id}" already exists at: ${existingSkills[0].replace(/\/.x_skill\.yaml$/, "")}. Set isUpdate: true to update.`);
        }
      }

      // Create destination directory (metadata only - no file copying)
      await fs.mkdir(destSkillDir, { recursive: true });

      // Generate .x_skill.yaml from issue content + SKILL.md description
      let meta = {
        specVersion: 2,
        id: item.id,
        title: item.title,
        description: description,
        category: item.targetCategory,
        tags: item.tags.length > 0 ? item.tags : undefined,
        source: {
          repo: req.sourceRepo,
          path: item.sourcePath,
          ref: req.ref,
          syncedCommit: commit
        }
      };

      // Remove undefined fields
      Object.keys(meta).forEach(key => {
        if (meta[key] === undefined) delete meta[key];
      });

      let destManifest = path.join(destSkillDir, ".x_skill.yaml");
      await fs.writeFile(destManifest, YAML.stringify(meta), "utf8");

      imported.push({ id: item.id, dest: destSkillDir, sourcePath: item.sourcePath, isUpdate: item.isUpdate });
    }

    console.log(`\nImported ${imported.length} skill(s) (metadata only):`);
    for (let i of imported) console.log(`- ${i.id} -> ${i.dest}/.x_skill.yaml${i.isUpdate ? " [UPDATE]" : ""}`);
    console.log(`\nNote: Skill files will be fetched during build by sync-skill-files.mjs`);
  } finally {
    // Clean up temp directory
    try {
      await fs.rm(tmp, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

await main();

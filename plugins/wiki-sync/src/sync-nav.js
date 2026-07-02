/**
 * Wiki.js 导航树同步脚本
 *
 * 同步导航文件夹下的 README.md 到 Wiki.js 作为导航页面。
 * 每个 README.md 的 wiki 路径 = 其父目录路径:
 *
 *   <nav-root>/README.md                  → wiki: <nav-root>
 *   <nav-root>/foo/README.md              → wiki: <nav-root>/foo
 *   <nav-root>/foo/bar/README.md          → wiki: <nav-root>/foo/bar
 *
 * 用法:
 *   bun run src/sync-nav.js --all                              # 同步所有导航页
 *   bun run src/sync-nav.js --all --dry-run                     # 预览
 *   bun run src/sync-nav.js --all --nav-root my-folder          # 自定义导航文件夹
 *   bun run src/sync-nav.js --all --nav-root my-folder --concurrency 10
 *   bun run src/sync-nav.js --rel ""                           # 同步根 README
 *   bun run src/sync-nav.js --rel "匈牙利/用户指南"               # 同步指定路径
 *   bun run src/sync-nav.js --rel "" --nav-root my-folder       # 自定义文件夹 + 单文件
 *   bun run src/sync-nav.js --list                              # 列出远程导航页
 *
 * .env 环境变量:
 *   WIKIJS_URL       - Wiki.js 地址 (默认 http://192.168.0.101:3000)
 *   WIKIJS_LOCALE    - 内容语言 (默认 zh)
 *   WIKIJS_USERNAME  - 用户名
 *   WIKIJS_PASSWORD  - 密码
 *   WIKIJS_STRATEGY  - 认证策略 UUID
 *
 * @format
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const BASE_URL = (Bun.env.WIKIJS_URL ?? "http://192.168.0.101:3000").replace(
  /\/+$/,
  "",
);
const LOCALE = Bun.env.WIKIJS_LOCALE ?? "zh";
const GRAPHQL = BASE_URL + "/graphql";

const USERNAME = Bun.env.WIKIJS_USERNAME;
const PASSWORD = Bun.env.WIKIJS_PASSWORD;
const STRATEGY = Bun.env.WIKIJS_STRATEGY;

if (!USERNAME || !PASSWORD || !STRATEGY) {
  console.error(
    "缺少环境变量: WIKIJS_USERNAME, WIKIJS_PASSWORD, WIKIJS_STRATEGY",
  );
  process.exit(1);
}

const args = process.argv.slice(2);

// 解析 --nav-root
const NAV_ROOT_IDX = args.indexOf("--nav-root");
const NAV_ROOT =
  NAV_ROOT_IDX >= 0 ? args[NAV_ROOT_IDX + 1] : "business-central";
const WIKI_PREFIX = NAV_ROOT;

const SKIP_FILES = new Set(["business-central-wiki-structure.md"]);

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

const LOGIN_MUTATION = `
  mutation ($username: String!, $password: String!, $strategy: String!) {
    authentication {
      login(username: $username, password: $password, strategy: $strategy) {
        responseResult { succeeded errorCode slug message }
        jwt
      }
    }
  }
`;

async function login() {
  console.log(`连接: ${BASE_URL}  用户: ${USERNAME}`);
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: LOGIN_MUTATION,
      variables: { username: USERNAME, password: PASSWORD, strategy: STRATEGY },
    }),
  });
  if (!res.ok) throw new Error(`登录 HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length)
    throw new Error("GraphQL: " + body.errors.map((e) => e.message).join("; "));
  const block = body.data?.authentication?.login;
  if (!block?.responseResult?.succeeded) {
    const { errorCode, message } = block?.responseResult ?? {};
    throw new Error(`登录失败: ${errorCode} - ${message}`);
  }
  const jwt = block.jwt;
  if (!jwt) throw new Error("登录成功但未返回 JWT");
  console.log("✅ 登录成功\n");
  return jwt;
}

// ---------------------------------------------------------------------------
// GraphQL 请求（带 JWT + 重试）
// 返回 { data, errors } 而不抛异常，由调用方处理
// ---------------------------------------------------------------------------

async function gql(jwt, query, variables) {
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(GRAPHQL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + jwt,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return { data: body.data, errors: body.errors || null };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 页面 API
// ---------------------------------------------------------------------------

async function findPageByPath(jwt, path) {
  const q = `
    query ($path: String!, $locale: String!) {
      pages { singleByPath(path: $path, locale: $locale) { id path title isPublished } }
    }
  `;
  const { data, errors } = await gql(jwt, q, { path, locale: LOCALE });
  if (errors || !data) return null;
  const page = data.pages?.singleByPath;
  return page?.id ? page : null;
}

async function createPage(jwt, path, title, content, description = "") {
  const q = `
    mutation ($content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
      pages { create(content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags, title: $title) {
        responseResult { succeeded errorCode slug message }
        page { id path title }
      } }
    }
  `;
  return gql(jwt, q, {
    content,
    description: description || title,
    editor: "markdown",
    isPublished: true,
    isPrivate: false,
    locale: LOCALE,
    path,
    tags: [],
    title,
  });
}

async function updatePage(jwt, pageId, title, content, description = "") {
  const q = `
    mutation ($id: Int!, $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!, $isPrivate: Boolean!, $tags: [String]!, $title: String!) {
      pages { update(id: $id, content: $content, description: $description, editor: $editor, isPublished: $isPublished, isPrivate: $isPrivate, tags: $tags, title: $title) {
        responseResult { succeeded errorCode slug message }
        page { id path title }
      } }
    }
  `;
  return gql(jwt, q, {
    id: pageId,
    content,
    description: description || title,
    editor: "markdown",
    isPublished: true,
    isPrivate: false,
    tags: [],
    title,
  });
}

async function listPages(jwt) {
  const all = [];
  let cursor = null;
  while (true) {
    const q = `
      query ($locale: String!, $cursor: String) {
        pages { list(locale: $locale, orderBy: TITLE, orderByDirection: ASC) {
          ... on PageConnection { edges { cursor node { id path title isPublished } } pageInfo { hasNextPage endCursor } }
        } }
      }
    `;
    const vars = { locale: LOCALE };
    if (cursor) vars.cursor = cursor;
    const { data } = await gql(jwt, q, vars);
    const conn = data?.pages?.list ?? {};
    for (const e of conn.edges ?? []) {
      if (e?.node) all.push(e.node);
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo?.endCursor ?? conn.edges?.at(-1)?.cursor;
    if (!cursor) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function titleFromContent(content, fallback) {
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (s.startsWith("# ")) {
      const t = s.slice(2).trim();
      if (t) return t;
    }
  }
  return fallback;
}

function relToPath(relPath) {
  let parts = relPath.replaceAll("\\", "/").split("/");
  if (
    parts.length > 0 &&
    parts[parts.length - 1].toLowerCase() === "readme.md"
  ) {
    parts.pop();
  }
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
    return WIKI_PREFIX;
  }
  return WIKI_PREFIX + "/" + parts.join("/");
}

function relToFallbackTitle(relPath) {
  let parts = relPath.replaceAll("\\", "/").split("/");
  if (
    parts.length > 0 &&
    parts[parts.length - 1].toLowerCase() === "readme.md"
  ) {
    parts.pop();
  }
  const last = parts[parts.length - 1];
  if (!last || last === "") return WIKI_PREFIX;
  return last;
}

// ---------------------------------------------------------------------------
// 收集导航文件
// ---------------------------------------------------------------------------

async function scanNavDir() {
  const { readdirSync, statSync } = await import("node:fs");

  let rootExists;
  try {
    rootExists = statSync(NAV_ROOT).isDirectory();
  } catch {
    rootExists = false;
  }
  if (!rootExists) {
    console.error(`导航目录不存在: ${NAV_ROOT}/`);
    process.exit(1);
  }

  const items = [];
  function walk(dir, relDir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = dir + "/" + entry.name;
      const rel = relDir ? relDir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && entry.name.toLowerCase() === "readme.md") {
        if (SKIP_FILES.has(entry.name)) continue;
        items.push({ relPath: rel, absPath: full.replaceAll("\\", "/") });
      }
    }
  }
  walk(NAV_ROOT, "");
  return items;
}

// ---------------------------------------------------------------------------
// 同步所有导航页
// ---------------------------------------------------------------------------

async function syncAll(jwt, dryRun = false, concurrency = 5) {
  const items = await scanNavDir();
  const total = items.length;
  console.log(`导航根目录: ${NAV_ROOT}/`);
  console.log(`Wiki 前缀 : ${WIKI_PREFIX}`);
  console.log(`待同步: ${total} 个导航页  (并发: ${concurrency})`);

  if (dryRun) {
    console.log("🔍 预览模式 — 不会实际推送\n");
    for (let i = 0; i < total; i++) {
      const { relPath } = items[i];
      const wikiPath = relToPath(relPath);
      console.log(
        `  [${String(i + 1).padStart(2)}/${total}] ${relPath.padEnd(50)} → ${wikiPath}`,
      );
    }
    return { created: 0, updated: 0, failed: 0, total };
  }

  console.log("");
  let created = 0,
    updated = 0,
    failed = 0;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < total) {
      const i = nextIdx++;
      const { relPath, absPath } = items[i];
      const prefix = `[${String(i + 1).padStart(2)}/${total}]`;

      try {
        const file = Bun.file(absPath);
        const content = await file.text();
        const wikiPath = relToPath(relPath);
        const fallback = relToFallbackTitle(relPath);
        const title = titleFromContent(content, fallback);

        const existing = await findPageByPath(jwt, wikiPath);
        let action;
        if (existing?.id) {
          const { data, errors } = await updatePage(
            jwt,
            existing.id,
            title,
            content,
            title.slice(0, 200),
          );
          const rr = data?.pages?.update?.responseResult;
          if (errors) {
            failed++;
            action =
              "ERR:" +
              errors
                .map((e) => e.message)
                .join(",")
                .slice(0, 30);
          } else if (rr?.succeeded) {
            updated++;
            action = "UPD";
          } else {
            failed++;
            action = "UPD-FAIL:" + (rr?.message || "").slice(0, 25);
          }
        } else {
          const { data, errors } = await createPage(
            jwt,
            wikiPath,
            title,
            content,
            title.slice(0, 200),
          );
          const rr = data?.pages?.create?.responseResult;
          if (errors) {
            failed++;
            action =
              "ERR:" +
              errors
                .map((e) => e.message)
                .join(",")
                .slice(0, 30);
          } else if (rr?.succeeded) {
            created++;
            action = "NEW";
          } else {
            failed++;
            action = "NEW-FAIL:" + (rr?.message || "").slice(0, 25);
          }
        }
        console.log(
          `${prefix} ${relPath.padEnd(48)} → ${wikiPath.padEnd(42)} ${action.padEnd(8)} ${title.slice(0, 35)}`,
        );
      } catch (err) {
        failed++;
        console.log(`${prefix} ${relPath} ❌ ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () =>
    worker(),
  );
  await Promise.all(workers);

  const ok = created + updated;
  console.log(
    `\n完成: ${ok} 成功 (新增 ${created}, 更新 ${updated}), ${failed} 失败, ${total} 总计`,
  );
  return { created, updated, failed, total };
}

// ---------------------------------------------------------------------------
// 同步单个导航页
// ---------------------------------------------------------------------------

async function syncOne(jwt, relStr, dryRun = false) {
  let absPath;
  if (relStr === "" || relStr === ".") {
    absPath = `${NAV_ROOT}/README.md`;
  } else {
    const asFolder = `${NAV_ROOT}/${relStr}/README.md`;
    const folderFile = Bun.file(asFolder);
    if (await folderFile.exists()) {
      absPath = asFolder;
    } else {
      absPath = `${NAV_ROOT}/${relStr}`;
    }
  }

  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    console.error(`文件不存在: ${absPath}`);
    process.exit(1);
  }

  const content = await file.text();
  const relPath =
    absPath.startsWith(NAV_ROOT + "/") ?
      absPath.slice(NAV_ROOT.length + 1)
    : absPath;
  const wikiPath = relToPath(relPath);
  const fallback = relToFallbackTitle(relPath);
  const title = titleFromContent(content, fallback);

  console.log(`源文件 : ${absPath}`);
  console.log(`相对路径: ${relPath}`);
  console.log(`Wiki 路径: ${wikiPath}`);
  console.log(`标题   : ${title}`);

  const existing = await findPageByPath(jwt, wikiPath);
  if (existing?.id) {
    console.log(
      `状态   : 已存在 (id=${existing.id}, published=${existing.isPublished})`,
    );
    console.log(`动作   : ${dryRun ? "将 UPDATE" : "UPDATING…"}`);
  } else {
    console.log(`状态   : 新页面`);
    console.log(`动作   : ${dryRun ? "将 CREATE" : "CREATING…"}`);
  }

  if (dryRun) {
    console.log("\n🔍 预览模式 — 去掉 --dry-run 实际推送");
    return;
  }

  if (existing?.id) {
    const { data, errors } = await updatePage(
      jwt,
      existing.id,
      title,
      content,
      title.slice(0, 200),
    );
    if (errors) {
      console.log(
        `❌ GraphQL 错误: ${errors.map((e) => e.message).join("; ")}`,
      );
      process.exit(1);
    }
    const rr = data?.pages?.update?.responseResult;
    if (rr?.succeeded) {
      console.log(
        `✅ 更新成功  id=${data.pages.update.page?.id}  path=${data.pages.update.page?.path}`,
      );
    } else {
      console.log(`❌ 更新失败  ${rr?.errorCode}: ${rr?.message}`);
      process.exit(1);
    }
  } else {
    const { data, errors } = await createPage(
      jwt,
      wikiPath,
      title,
      content,
      title.slice(0, 200),
    );
    if (errors) {
      console.log(
        `❌ GraphQL 错误: ${errors.map((e) => e.message).join("; ")}`,
      );
      process.exit(1);
    }
    const rr = data?.pages?.create?.responseResult;
    if (rr?.succeeded) {
      console.log(
        `✅ 创建成功  id=${data.pages.create.page?.id}  path=${data.pages.create.page?.path}`,
      );
    } else {
      console.log(`❌ 创建失败  ${rr?.errorCode}: ${rr?.message}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// 列出远程导航页
// ---------------------------------------------------------------------------

async function listNavPages(jwt) {
  const all = await listPages(jwt);
  const nav = all.filter((p) => (p.path || "").startsWith(WIKI_PREFIX));
  console.log(
    `导航页面 (locale=${LOCALE}, prefix=${WIKI_PREFIX}): ${nav.length}\n`,
  );
  for (const p of nav.sort((a, b) =>
    (a.path || "").localeCompare(b.path || ""),
  )) {
    console.log(
      `  id=${String(p.id).padStart(5)}  path=${(p.path || "").padEnd(55)}  pub=${p.isPublished}  ${(p.title || "").slice(0, 50)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const MODE_ALL = args.includes("--all");
const MODE_DRY_RUN = args.includes("--dry-run");
const MODE_LIST = args.includes("--list");
const REL_IDX = args.indexOf("--rel");
const MODE_REL = REL_IDX >= 0;
const REL_PATH = MODE_REL ? (args[REL_IDX + 1] ?? "") : null;
const CONC_IDX = args.indexOf("--concurrency");
const CONCURRENCY =
  CONC_IDX >= 0 ? Number.parseInt(args[CONC_IDX + 1], 10) || 5 : 5;

const jwt = await login();

if (MODE_LIST) {
  await listNavPages(jwt);
} else if (MODE_REL) {
  await syncOne(jwt, REL_PATH, MODE_DRY_RUN);
} else if (MODE_ALL) {
  await syncAll(jwt, MODE_DRY_RUN, CONCURRENCY);
} else {
  console.log("用法:");
  console.log(
    "  bun run src/sync-nav.js --all                              # 同步所有",
  );
  console.log(
    "  bun run src/sync-nav.js --all --dry-run                     # 预览",
  );
  console.log(
    "  bun run src/sync-nav.js --all --nav-root <folder>           # 自定义文件夹",
  );
  console.log(
    '  bun run src/sync-nav.js --rel "路径"                        # 同步单个',
  );
  console.log(
    '  bun run src/sync-nav.js --rel "" --nav-root <folder>        # 自定义 + 单个',
  );
  console.log(
    "  bun run src/sync-nav.js --list                              # 列出远程",
  );
}

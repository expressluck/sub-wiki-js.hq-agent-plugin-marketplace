/**
 * Wiki.js 页面同步脚本
 *
 * 同步 pages/ 目录下的 .md 文件到 Wiki.js。
 * 文件名: <32位hex uuid>.md  →  Wiki路径: pages/<uuid>
 * 标题: 从 markdown 第一个 # heading 提取
 *
 * 用法:
 *   bun run src/sync-pages.js --all                      # 同步所有页面
 *   bun run src/sync-pages.js --all --dry-run             # 预览（不实际推送）
 *   bun run src/sync-pages.js --all --concurrency 10      # 指定并发数
 *   bun run src/sync-pages.js --page <uuid>               # 同步单个页面
 *   bun run src/sync-pages.js --page <uuid> --dry-run     # 预览单个
 *   bun run src/sync-pages.js --list                      # 列出远程页面
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
const PAGES_DIR = "pages";
const HEX32_RE = /^[0-9a-f]{32}$/;

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

async function gql(jwt, query, variables, label = "gql") {
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
  const { data, errors } = await gql(
    jwt,
    q,
    { path, locale: LOCALE },
    "findPage",
  );
  // page not found → errors with "This page does not exist."
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
  return gql(
    jwt,
    q,
    {
      content,
      description: description || title,
      editor: "markdown",
      isPublished: true,
      isPrivate: false,
      locale: LOCALE,
      path,
      tags: [],
      title,
    },
    "createPage",
  );
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
  return gql(
    jwt,
    q,
    {
      id: pageId,
      content,
      description: description || title,
      editor: "markdown",
      isPublished: true,
      isPrivate: false,
      tags: [],
      title,
    },
    "updatePage",
  );
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
    const { data } = await gql(jwt, q, vars, "listPages");
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

function pagePath(uuid) {
  return `pages/${uuid}`;
}

// ---------------------------------------------------------------------------
// 同步所有页面
// ---------------------------------------------------------------------------

async function syncAll(jwt, dryRun = false, concurrency = 5) {
  const { readdirSync } = await import("node:fs");

  // 收集所有合规的 .md 文件
  const items = [];
  let dirEntries;
  try {
    dirEntries = readdirSync(PAGES_DIR);
  } catch {
    console.error(`目录不存在: ${PAGES_DIR}/`);
    process.exit(1);
  }
  for (const name of dirEntries) {
    if (!name.endsWith(".md")) continue;
    const uuid = name.slice(0, -3);
    if (!HEX32_RE.test(uuid)) {
      console.log(`  ⚠ 跳过非 uuid 文件: ${name}`);
      continue;
    }
    items.push({ uuid, filePath: `${PAGES_DIR}/${name}` });
  }

  const total = items.length;
  console.log(`待同步: ${total} 个页面  (并发: ${concurrency})`);

  if (dryRun) {
    console.log("🔍 预览模式 — 不会实际推送\n");
    for (let i = 0; i < Math.min(total, 15); i++) {
      const { uuid, filePath } = items[i];
      const file = Bun.file(filePath);
      const content = await file.text();
      const title = titleFromContent(content, uuid);
      console.log(
        `  [${String(i + 1).padStart(3)}/${total}] ${uuid.slice(0, 8)}…  →  ${pagePath(uuid)}  (${title.slice(0, 40)})`,
      );
    }
    if (total > 15) console.log(`  ... 还有 ${total - 15} 个`);
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
      const { uuid, filePath } = items[i];
      const prefix = `[${String(i + 1).padStart(3)}/${total}]`;
      const shortId = uuid.slice(0, 8);

      try {
        const file = Bun.file(filePath);
        const content = await file.text();
        const title = titleFromContent(content, uuid);
        const path = pagePath(uuid);

        const existing = await findPageByPath(jwt, path);
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
            path,
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
          `${prefix} ${shortId}… → ${path.padEnd(46)} ${action.padEnd(8)} ${title.slice(0, 40)}`,
        );
      } catch (err) {
        failed++;
        console.log(`${prefix} ${shortId}… ❌ ${err.message}`);
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
// 同步单个页面
// ---------------------------------------------------------------------------

async function syncOne(jwt, uuid, dryRun = false) {
  if (!HEX32_RE.test(uuid)) {
    console.error(`无效 uuid: "${uuid}" (需要 32 位 hex 字符，无连字符)`);
    process.exit(1);
  }

  const filePath = `${PAGES_DIR}/${uuid}.md`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(1);
  }

  const content = await file.text();
  const title = titleFromContent(content, uuid);
  const path = pagePath(uuid);

  console.log(`UUID : ${uuid}`);
  console.log(`文件 : ${filePath}`);
  console.log(`标题 : ${title}`);
  console.log(`路径 : ${path}`);

  const existing = await findPageByPath(jwt, path);
  if (existing?.id) {
    console.log(
      `状态 : 已存在 (id=${existing.id}, published=${existing.isPublished})`,
    );
    console.log(`动作 : ${dryRun ? "将 UPDATE" : "UPDATING…"}`);
  } else {
    console.log(`状态 : 新页面`);
    console.log(`动作 : ${dryRun ? "将 CREATE" : "CREATING…"}`);
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
      path,
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
// 列出远程页面
// ---------------------------------------------------------------------------

async function listRemotePages(jwt) {
  const all = await listPages(jwt);
  const filtered = all.filter((p) => (p.path || "").startsWith("pages/"));
  console.log(`全部页面 (locale=${LOCALE}): ${all.length}`);
  console.log(`pages/ 下的页面: ${filtered.length}\n`);
  for (const p of filtered.sort((a, b) =>
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
const PAGE_IDX = args.indexOf("--page");
const MODE_PAGE = PAGE_IDX >= 0;
const PAGE_UUID = MODE_PAGE ? args[PAGE_IDX + 1] : null;
const CONC_IDX = args.indexOf("--concurrency");
const CONCURRENCY =
  CONC_IDX >= 0 ? Number.parseInt(args[CONC_IDX + 1], 10) || 5 : 5;

const jwt = await login();

if (MODE_LIST) {
  await listRemotePages(jwt);
} else if (MODE_PAGE) {
  if (!PAGE_UUID) {
    console.error("--page 需要指定 uuid");
    process.exit(1);
  }
  await syncOne(jwt, PAGE_UUID, MODE_DRY_RUN);
} else if (MODE_ALL) {
  await syncAll(jwt, MODE_DRY_RUN, CONCURRENCY);
} else {
  console.log("用法:");
  console.log(
    "  bun run src/sync-pages.js --all                  # 同步所有页面",
  );
  console.log("  bun run src/sync-pages.js --all --dry-run         # 预览");
  console.log("  bun run src/sync-pages.js --page <uuid>           # 同步单个");
  console.log("  bun run src/sync-pages.js --list                  # 列出远程");
}

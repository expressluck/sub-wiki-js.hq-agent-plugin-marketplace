/**
 * Wiki.js 文件上传脚本
 *
 * 用法:
 *   bun run src/upload.js                              # 上传默认测试文件
 *   bun run src/upload.js <文件路径>                     # 上传指定文件
 *   bun run src/upload.js <文件路径> <远程文件名>          # 指定远程文件名
 *   bun run src/upload.js --all                         # 批量上传 assets/ 所有文件（并发5）
 *   bun run src/upload.js --all --dry-run               # 预览批量上传（不实际执行）
 *   bun run src/upload.js --all --concurrency 10         # 批量上传，指定并发数
 *   bun run src/upload.js --list                        # 列出远程资源
 *
 * 默认测试文件: assets/02c768a2-06fa-4ebf-b7b5-90ec858ce892.png
 *
 * .env 环境变量:
 *   WIKIJS_URL       - Wiki.js 地址 (默认 http://192.168.0.101:3000)
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
const GRAPHQL = BASE_URL + "/graphql";
const UPLOAD_URL = BASE_URL + "/u";

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
const DEFAULT_FILE = "assets/02c768a2-06fa-4ebf-b7b5-90ec858ce892.png";
const ASSETS_DIR = "assets";
const FOLDER_ID = 1;

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

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.json();

  if (body.errors?.length)
    throw new Error("GraphQL: " + body.errors.map((e) => e.message).join("; "));

  const loginBlock = body.data?.authentication?.login;
  if (!loginBlock?.responseResult?.succeeded) {
    const { errorCode, message } = loginBlock?.responseResult ?? {};
    throw new Error(`登录失败: ${errorCode} - ${message}`);
  }

  const jwt = loginBlock.jwt;
  if (!jwt) throw new Error("登录成功但未返回 JWT");

  console.log("✅ 登录成功\n");
  return jwt;
}

// ---------------------------------------------------------------------------
// GraphQL 请求（带 JWT）
// ---------------------------------------------------------------------------

async function graphql(query, variables, jwt) {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + jwt,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length)
    throw new Error("GraphQL: " + body.errors.map((e) => e.message).join("; "));
  return body.data;
}

// ---------------------------------------------------------------------------
// 列出远程资源
// ---------------------------------------------------------------------------

const LIST_ASSETS_QUERY = `
  query ($folderId: Int!, $kind: AssetKind!) {
    assets { list(folderId: $folderId, kind: $kind) {
      id filename ext kind mime fileSize createdAt updatedAt
    } }
  }
`;

async function listAssets(jwt) {
  const data = await graphql(
    LIST_ASSETS_QUERY,
    { folderId: FOLDER_ID, kind: "ALL" },
    jwt,
  );
  const assets = data.assets.list ?? [];
  console.log(`远程资源 (folderId=${FOLDER_ID}): ${assets.length} 个文件\n`);
  for (const a of assets) {
    console.log(
      `  id=${String(a.id).padStart(5)}  ${a.filename.padEnd(46)}  ${a.ext.padEnd(6)}  ${String(a.fileSize).padStart(10)} bytes`,
    );
  }
}

// ---------------------------------------------------------------------------
// 上传单个文件
// ---------------------------------------------------------------------------

async function uploadAsset(
  jwt,
  filePath,
  remoteName,
  folderId = FOLDER_ID,
  opts = {},
) {
  const { quiet = false } = opts;
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error("文件不存在: " + filePath);
  }

  const name = remoteName ?? file.name ?? filePath.replace(/^.*[/\\]/, "");
  const fileBytes = await file.bytes();
  const mime = file.type || "application/octet-stream";

  // 手动构造 multipart/form-data 请求体
  const boundary = "----BunUpload" + Math.random().toString(36).slice(2);

  const metadata = JSON.stringify({ folderId });
  const enc = new TextEncoder();

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="mediaUpload"\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="mediaUpload"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
  ];

  const head = parts[0] + parts[1];
  const tail = `\r\n--${boundary}--\r\n`;

  const headBytes = enc.encode(head);
  const tailBytes = enc.encode(tail);

  const requestBody = new Uint8Array(
    headBytes.length + fileBytes.length + tailBytes.length,
  );
  requestBody.set(headBytes, 0);
  requestBody.set(fileBytes, headBytes.length);
  requestBody.set(tailBytes, headBytes.length + fileBytes.length);

  const MAX_RETRIES = 10;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (!quiet)
        console.log(`  上传中... (第 ${attempt}/${MAX_RETRIES} 次尝试)`);

      const res = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + jwt,
          "Content-Type": "multipart/form-data; boundary=" + boundary,
        },
        body: requestBody,
        signal: AbortSignal.timeout(5000),
      });

      let resBody;
      const resText = await res.text();
      try {
        resBody = JSON.parse(resText);
      } catch {
        resBody = resText;
      }

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        body: resBody,
      };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const wait = 3000 * attempt;
        if (!quiet)
          console.log(`  ⚠ 失败: ${err.message}，${wait / 1000}s 后重试...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// 批量上传
// ---------------------------------------------------------------------------

async function uploadAllAssets(jwt, dryRun = false, concurrency = 5) {
  const { readdirSync } = await import("node:fs");

  // 检查 assets 目录
  try {
    readdirSync(ASSETS_DIR);
  } catch {
    console.error(`目录不存在: ${ASSETS_DIR}/`);
    process.exit(1);
  }

  // 收集所有文件（递归）
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = dir + "/" + entry.name;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full.replaceAll("\\", "/"));
      }
    }
  }
  walk(ASSETS_DIR);

  const total = files.length;
  console.log(`待上传: ${total} 个文件  (并发: ${concurrency})`);
  if (dryRun) {
    console.log("🔍 预览模式 — 不会实际上传\n");
    for (let i = 0; i < total; i++) {
      const f = files[i];
      const file = Bun.file(f);
      const size = (file.size / 1024).toFixed(1);
      console.log(
        `  [${String(i + 1).padStart(4)}/${total}] ${f.padEnd(60)} ${size} KB`,
      );
    }
    return { uploaded: 0, failed: 0, skipped: 0, total };
  }

  console.log("");
  let uploaded = 0;
  let failed = 0;
  let nextIndex = 0;

  // 单个上传任务（从池中消费）
  async function worker() {
    while (nextIndex < total) {
      const i = nextIndex++;
      const f = files[i];
      const file = Bun.file(f);
      const sizeKB = (file.size / 1024).toFixed(1);
      const prefix = `[${String(i + 1).padStart(4)}/${total}]`;

      try {
        const result = await uploadAsset(jwt, f, undefined, FOLDER_ID, {
          quiet: true,
        });
        if (result.ok) {
          console.log(`${prefix} ${f.padEnd(56)} ${sizeKB.padStart(7)} KB  ✅`);
          uploaded++;
        } else {
          console.log(
            `${prefix} ${f.padEnd(56)} ${sizeKB.padStart(7)} KB  ❌ HTTP ${result.status}`,
          );
          failed++;
        }
      } catch (err) {
        console.log(
          `${prefix} ${f.padEnd(56)} ${sizeKB.padStart(7)} KB  ❌ ${err.message}`,
        );
        failed++;
      }
    }
  }

  // 启动并发 workers
  const workers = Array.from({ length: Math.min(concurrency, total) }, () =>
    worker(),
  );
  await Promise.all(workers);

  console.log(`\n完成: ${uploaded} 成功, ${failed} 失败, ${total} 总计`);
  return { uploaded, failed, skipped: 0, total };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const MODE_ALL = args.includes("--all");
const MODE_DRY_RUN = args.includes("--dry-run");
const MODE_LIST = args.includes("--list");
const CONC_IDX = args.indexOf("--concurrency");
const CONCURRENCY =
  CONC_IDX >= 0 ? Number.parseInt(args[CONC_IDX + 1], 10) || 5 : 5;

const jwt = await login();

if (MODE_LIST) {
  await listAssets(jwt);
} else if (MODE_ALL) {
  await uploadAllAssets(jwt, MODE_DRY_RUN, CONCURRENCY);
} else {
  const filePath = args[0] ?? DEFAULT_FILE;
  const remoteName = args[1] ?? undefined;

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error("文件不存在: " + filePath);
    process.exit(1);
  }

  console.log(`本地文件: ${filePath}  (${file.size} bytes)`);
  console.log(`远程名称: ${remoteName ?? (file.name || filePath)}\n`);

  const result = await uploadAsset(jwt, filePath, remoteName);

  if (result.ok) {
    console.log("✅ 上传成功!");
    console.log("响应:", JSON.stringify(result.body, null, 2));
  } else {
    console.log(`❌ 上传失败  HTTP ${result.status} ${result.statusText}`);
    console.log("响应:", result.body);
    process.exit(1);
  }
}

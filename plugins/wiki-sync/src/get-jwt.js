/**
 * Wiki.js JWT 获取脚本
 *
 * 运行: bun run src/get-jwt.js
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
const ENDPOINT = BASE_URL + "/graphql";

const USERNAME = Bun.env.WIKIJS_USERNAME;
const PASSWORD = Bun.env.WIKIJS_PASSWORD;
const STRATEGY = Bun.env.WIKIJS_STRATEGY;

if (!USERNAME || !PASSWORD || !STRATEGY) {
  console.error(
    "缺少环境变量: WIKIJS_USERNAME, WIKIJS_PASSWORD, WIKIJS_STRATEGY",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 登录 mutation
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

  const res = await fetch(ENDPOINT, {
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

  return jwt;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const jwt = await login();

console.log("\n✅ 登录成功!\n");
console.log("JWT Token:");
console.log("─".repeat(60));
console.log(jwt);
console.log("─".repeat(60));

// 解码 payload（不验证签名）
// atob 只认标准 base64，JWT 用的是 base64url（_ -> /, - -> +）
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  // 补全 padding
  while (str.length % 4) str += "=";
  return atob(str);
}

const parts = jwt.split(".");
if (parts.length === 3) {
  const payload = JSON.parse(base64urlDecode(parts[1]));
  console.log("\nJWT Payload:");
  console.log(JSON.stringify(payload, null, 2));
}

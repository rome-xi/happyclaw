// 在任何其它模块读取 process.env 之前，把项目根目录的 .env 加载进环境变量。
// 自托管部署用 .env 配置 CORS_ALLOWED_ORIGINS（公网域名白名单）、自定义 env 等。
// 必须作为 index.ts 的第一个 import，确保 config.ts / web.ts 在求值时已能读到这些值。
// 缺少 .env 文件属正常情况（所有 env 均有默认值），静默忽略。
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

try {
  // process.loadEnvFile() 读取 cwd 下的 .env（Node 20.12+ / 21.7+ 起稳定）。
  process.loadEnvFile();
} catch {
  /* 无 .env 文件，跳过 */
}

// Node 的全局 fetch 默认不读取 HTTP(S)_PROXY。让 OAuth 交换、provider
// 连通性测试等服务端请求遵守系统代理与 NO_PROXY；只配 ALL_PROXY/SOCKS
// 时不启用，因为 EnvHttpProxyAgent 不支持它们。
const httpProxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
if (httpProxy) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    // 不打印代理 URL / userinfo / NO_PROXY，避免内部拓扑或凭据进入日志。
    console.log('[load-env] 全局 fetch 已启用 HTTP(S) 代理');
  } catch (err) {
    console.warn(
      '[load-env] 设置全局 fetch 代理失败，server-side fetch 将直连:',
      err instanceof Error ? err.message : err,
    );
  }
}

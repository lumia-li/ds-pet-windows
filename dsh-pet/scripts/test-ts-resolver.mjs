/**
 * 测试用模块解析钩子：把 src/ 里无扩展名的相对 import 补成 `.ts`（含目录索引），
 * 并把 DSH 的 peer 包映射到独立模式的 shim 上。
 *
 * 为什么要补扩展名：src/shared 是给打包器吃的源码（moduleResolution: Bundler），相对 import 一律
 * 不写扩展名（`./pickers`）。而单测走 `node --experimental-strip-types` 直连源文件，Node 的
 * ESM 解析器要求完整说明符，`./pickers` 会 ERR_MODULE_NOT_FOUND。
 *
 * 为什么要映射 DSH 包：宿主半边（src/host）静态 import 三个 `@deepseek-ai/*` 包，它们只在装了
 * DSH 的环境里存在（package.json 的 peerDependencies）。构建独立模式时 tsdown 用 alias 把它们
 * 换成 src/standalone/shims/*，所以**产物**不依赖 DSH；但源码直连测试没有打包器，缺包就整组
 * 用例 ERR_MODULE_NOT_FOUND。这里补上同一条映射，让源码也能在没有 DSH 的机器上跑测试。
 */
import { fileURLToPath } from 'node:url';

/** DSH peer 包 → 独立模式 shim（与 tsdown.config.mjs 的 alias 一一对应） */
const SHIMS = {
  '@deepseek-ai/dsh-home-paths': new URL('../src/standalone/shims/dsh-home-paths.ts', import.meta.url).href,
  '@deepseek-ai/dsh-credentials': new URL('../src/standalone/shims/dsh-credentials.ts', import.meta.url).href,
  '@deepseek-ai/dsh-llm': new URL('../src/standalone/shims/dsh-llm.ts', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const shim = SHIMS[specifier];
  if (shim) return { url: shim, shortCircuit: true };
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!/\.[cm]?[jt]sx?$/.test(specifier) && !specifier.endsWith('.json')) {
      for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
        try {
          return await nextResolve(candidate, context);
        } catch {
          /* 继续试下一个候选；都不行就落回原说明符，让 Node 报它自己的错 */
        }
      }
    }
  }
  return nextResolve(specifier, context);
}

// 供调试：`node -e "import('./scripts/test-ts-resolver.mjs').then(m => console.log(m.SHIM_PATHS))"`
export const SHIM_PATHS = Object.fromEntries(
  Object.entries(SHIMS).map(([specifier, url]) => [specifier, fileURLToPath(url)]),
);

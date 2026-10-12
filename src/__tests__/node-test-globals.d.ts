/**
 * 测试用的最小 Node 内置模块声明。
 *
 * ⚠️ 为什么不装 `@types/node`：`tsconfig.json` 的 `types` 只开了 `vitest/globals`，
 * 前端代码不应看到 Node 全局（`process`/`Buffer` 等）。装 @types/node 会把这些
 * 全局泄漏进 `src/**` 的类型检查范围，属于超出本次修复范围的依赖变更。
 *
 * 这里只声明 `src/__tests__/coords.test.ts` 真实读资产文件所需的最小接口，
 * 避免为一个测试引入整包类型。
 */

declare module 'node:fs' {
  export function readdirSync(path:string):string[];
  export function writeFileSync(path:string,data:string):void;
  export function existsSync(p: string): boolean;
  export function readFileSync(p: string): Uint8Array;
  export function readFileSync(p: string, enc: string): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

/** vitest 以项目根为 cwd 运行 */
declare const process: { cwd(): string };
declare module 'node:module' {export function createRequire(url:string): (id:string)=>any;}

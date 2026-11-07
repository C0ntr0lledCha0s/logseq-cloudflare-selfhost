// The one node:async_hooks API the connector uses (nodejs_compat provides the module at runtime).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}

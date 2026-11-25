/**
 * 키(앱)별로 작업을 한 줄로 세운다. 같은 레포에서 두 에이전트가 동시에 브랜치를 만지는 일을 막는다.
 */
export class SerialQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.tails.set(key, next);
    // finally()가 만드는 파생 promise도 reject 되므로 삼켜야 unhandled rejection으로 프로세스가 죽지 않는다.
    next
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  pending(key: string): boolean {
    return this.tails.has(key);
  }
}

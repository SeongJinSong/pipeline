import { expect, it } from "vitest";
import { SerialQueue } from "../src/util/serial.js";

it("같은 키는 순서대로, 실패해도 다음 작업은 실행", async () => {
  const q = new SerialQueue();
  const log: string[] = [];
  const slow = (name: string, ms: number) => async () => {
    log.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}:end`);
  };
  const a = q.run("app", slow("a", 20));
  const b = q.run("app", async () => {
    throw new Error("boom");
  });
  const c = q.run("app", slow("c", 1));
  expect(q.pending("app")).toBe(true);
  await a;
  await expect(b).rejects.toThrow("boom");
  await c;
  expect(log).toEqual(["a:start", "a:end", "c:start", "c:end"]);
  await new Promise((r) => setTimeout(r, 0));
  expect(q.pending("app")).toBe(false);
});

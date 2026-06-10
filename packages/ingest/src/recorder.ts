import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RawTxEvent } from "@tradebot/core";

export function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { __bigint: value.toString() };
  return value;
}

export function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint" in value &&
    typeof (value as Record<string, unknown>)["__bigint"] === "string"
  ) {
    const v = (value as Record<string, unknown>)["__bigint"];
    if (typeof v === "string") return BigInt(v);
    return value;
  }
  return value;
}

export function serializeEvent(event: RawTxEvent): string {
  return JSON.stringify(event, bigintReplacer);
}

export function deserializeEvent(line: string): RawTxEvent {
  return JSON.parse(line, bigintReviver) as RawTxEvent;
}

export class Recorder {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async record(event: RawTxEvent): Promise<void> {
    const date = new Date(event.observedAt).toISOString().slice(0, 10);
    const file = join(this.dir, `${event.chain}-${date}.jsonl`);
    await mkdir(this.dir, { recursive: true });
    await appendFile(file, serializeEvent(event) + "\n", "utf8");
  }
}

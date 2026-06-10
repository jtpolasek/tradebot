import { EventEmitter } from "node:events";
import type { RawTxEvent, TradeSignal, PaperFill } from "./types.js";

type BusEvents = {
  "raw-tx": RawTxEvent;
  "trade-signal": TradeSignal;
  "signal-confirmed": { signalId: string; confirmed: TradeSignal };
  "signal-voided": { signalId: string; reason: "reverted" | "replaced" };
  "paper-fill": PaperFill;
};

type BusEventName = keyof BusEvents;

export class EventBus {
  private emitter = new EventEmitter();

  emit<K extends BusEventName>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends BusEventName>(event: K, listener: (payload: BusEvents[K]) => void): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends BusEventName>(event: K, listener: (payload: BusEvents[K]) => void): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends BusEventName>(event: K, listener: (payload: BusEvents[K]) => void): void {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
  }
}

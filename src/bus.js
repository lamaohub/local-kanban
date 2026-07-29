import { EventEmitter } from 'node:events';
import { sseMax } from './config.js';

export const bus = new EventEmitter();
export const SSE_MAX = sseMax();
bus.setMaxListeners(SSE_MAX + 10);

export function emit(type, data) {
  bus.emit('event', { type, data });
}

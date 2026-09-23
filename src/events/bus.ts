/**
 * Single in-process stream of domain events. Every state change that Shaype would notify about is
 * emitted here exactly once by the owning service; the webhook mapper subscribes and turns events
 * into NotificationDto payloads. Payload types are declared by the domains that emit them.
 */
import { EventEmitter } from 'node:events'

// Domain modules augment this interface: `declare module '../events/bus.js' { interface DomainEventMap { ... } }`
export interface DomainEventMap {}

export type DomainEventName = keyof DomainEventMap & string

export class DomainEvents {
  private readonly emitter = new EventEmitter({ captureRejections: false })

  emit<K extends DomainEventName>(name: K, payload: DomainEventMap[K]): void {
    this.emitter.emit(name, payload)
    this.emitter.emit('*', { name, payload })
  }
  on<K extends DomainEventName>(name: K, listener: (payload: DomainEventMap[K]) => void): () => void {
    this.emitter.on(name, listener)
    return () => this.emitter.off(name, listener)
  }
  onAny(listener: (event: { name: DomainEventName; payload: unknown }) => void): () => void {
    this.emitter.on('*', listener)
    return () => this.emitter.off('*', listener)
  }
}

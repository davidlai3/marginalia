import type { NumberedLayer } from "../layer/number.js";

export class LayerStore {
  private layer: NumberedLayer | null = null;
  private listeners = new Set<(layer: NumberedLayer) => void>();

  get(): NumberedLayer | null {
    return this.layer;
  }

  /** Replace the live layer. Only one is ever current — layers are ephemeral. */
  set(layer: NumberedLayer): void {
    this.layer = layer;
    for (const fn of this.listeners) fn(layer);
  }

  subscribe(fn: (layer: NumberedLayer) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

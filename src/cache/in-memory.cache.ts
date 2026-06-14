import { Cache } from '../interfaces/cache.interface';

export class InMemoryCache implements Cache {
  private cache = new Map<string, string>();

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
  }

  size(): number {
    return this.cache.size;
  }
}

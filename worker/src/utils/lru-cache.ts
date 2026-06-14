/**
 * LRU (Least Recently Used) 缓存实现
 *
 * 特性：
 * - O(1) 获取和设置
 * - 自动淘汰最久未使用的条目
 * - 线程安全（单线程JavaScript环境）
 */

export class LRUCache<K, V> {
  private cache: Map<K, { value: V; expiresAt: number }>;
  protected maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * 获取缓存值
   * 如果存在且未过期，则移动到最近使用（Map会保持插入顺序）
   */
  get(key: K, now: number): V | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    if (entry.expiresAt <= now) {
      this.cache.delete(key);
      return null;
    }

    // 移动到最近使用（删除后重新插入）
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * 设置缓存值
   * 如果缓存已满，删除最久未使用的条目（Map的第一个条目）
   */
  set(key: K, value: V, ttlMs: number, now: number): void {
    // 如果key已存在，先删除（保证插入到末尾）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 如果缓存已满，删除最久未使用的条目
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    // 插入新条目
    this.cache.set(key, {
      value,
      expiresAt: now + ttlMs,
    });
  }

  /**
   * 删除指定key
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 清理过期条目
   */
  cleanup(now: number): number {
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * 遍历所有有效条目
   */
  *entries(now: number): Generator<[K, V]> {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt > now) {
        yield [key, entry.value];
      }
    }
  }

  /**
   * 检查是否包含key（不更新访问顺序）
   */
  has(key: K, now: number): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= now) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }
}

/**
 * 带统计信息的LRU缓存
 */
export class LRUCacheWithStats<K, V> extends LRUCache<K, V> {
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  get(key: K, now: number): V | null {
    const value = super.get(key, now);
    if (value !== null) {
      this.hits++;
    } else {
      this.misses++;
    }
    return value;
  }

  set(key: K, value: V, ttlMs: number, now: number): void {
    const wasFull = this.size >= this.maxSize;
    super.set(key, value, ttlMs, now);
    if (wasFull) {
      this.evictions++;
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? (this.hits / total * 100).toFixed(2) + '%' : '0%',
      size: this.size,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}
